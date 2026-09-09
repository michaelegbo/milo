#!/usr/bin/env python3
"""Prepare static model downloads; this script performs no model inference."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import urllib.request

CHAT_MODELS = (
    ('fast.gguf', 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', '91cad51170dc346986eccefdc2dd33a9da36ead9',
     'qwen2.5-1.5b-instruct-q4_k_m.gguf', '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e'),
    ('quality.gguf', 'Qwen/Qwen3-4B-GGUF', 'bc640142c66e1fdd12af0bd68f40445458f3869b',
     'Qwen3-4B-Q4_K_M.gguf', '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5'),
)
AUDIO_FILES = {
    'onnx-community/Kokoro-82M-v1.0-ONNX': ('models', (
        'config.json', 'tokenizer_config.json', 'tokenizer.json', 'onnx/model_quantized.onnx')),
    'Xenova/whisper-base.en': ('stt', (
        'config.json', 'tokenizer_config.json', 'tokenizer.json', 'preprocessor_config.json',
        'generation_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx')),
}


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def atomic_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.' + target.name, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        shutil.copyfile(source, temporary)
        temporary.chmod(0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def download(directory, model):
    name, repository, revision, remote_name, expected = model
    target = directory / name
    if target.is_file() and digest(target) == expected:
        print(f'Verified cached {name}', flush=True)
        return target
    url = f'https://huggingface.co/{repository}/resolve/{revision}/{remote_name}'
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.' + name, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            print(f'Downloading {repository} at {revision}', flush=True)
            request = urllib.request.Request(url, headers={'User-Agent': 'Milo-static-model-preparation/1'})
            hasher = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=120) as response:
                for chunk in iter(lambda: response.read(8 * 1024 * 1024), b''):
                    handle.write(chunk)
                    hasher.update(chunk)
            if hasher.hexdigest() != expected:
                raise RuntimeError(f'SHA256 mismatch for {name}; existing model was preserved')
        except BaseException:
            handle.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.chmod(0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def gguf_tensor_count(path):
    with path.open('rb') as handle:
        header = handle.read(24)
    if len(header) != 24:
        raise RuntimeError(f'Truncated GGUF header: {path.name}')
    magic, version, tensors, metadata = struct.unpack('<4sIQQ', header)
    if magic != b'GGUF' or version not in (2, 3) or not tensors or not metadata:
        raise RuntimeError(f'Invalid GGUF header: {path.name}')
    return tensors


def validate_shards(directory, original):
    expected = [directory / f'quality-{index:05d}-of-00005.gguf' for index in range(1, 6)]
    actual = sorted(directory.glob('quality-*-of-*.gguf'))
    if actual != expected:
        raise RuntimeError('Expected exactly five sequential Quality shards; check the split tool and 512M setting')
    for path in expected:
        if not 24 < path.stat().st_size < 512 * 1024 * 1024:
            raise RuntimeError(f'Quality shard is empty or too large: {path.name}')
    if sum(gguf_tensor_count(path) for path in expected) != gguf_tensor_count(original):
        raise RuntimeError('Quality shard tensor counts do not match the verified source model')
    return expected


def describe(path, base):
    return {'url': '/models/' + path.relative_to(base).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path, help='Static model directory mounted into Nginx')
    parser.add_argument('--split-tool', required=True, type=Path, help='Existing compatible llama-gguf-split executable')
    parser.add_argument('--audio-cache', type=Path, help='Optional original Milo server/.cache directory containing working Kokoro and Whisper models')
    args = parser.parse_args()
    base = args.directory.expanduser().resolve()
    split_tool = args.split_tool.expanduser().resolve()
    if not split_tool.is_file():
        parser.error('--split-tool must name an existing executable; this script does not install software')
    base.mkdir(parents=True, exist_ok=True)
    chat = base / 'chat'
    chat.mkdir(exist_ok=True)

    # Check all supplied audio files before publishing any of them. Existing
    # cached audio is an operator-supplied input, not downloaded from a moving tag.
    audio_sources = []
    for model_id, (cache_kind, files) in AUDIO_FILES.items():
        for name in files:
            target = base / model_id / name
            source = args.audio_cache.resolve() / cache_kind / model_id / name if args.audio_cache else target
            if not source.is_file() or source.stat().st_size == 0:
                parser.error(f'Missing audio asset: {source}. Supply a complete --audio-cache or populate the static directory first.')
            if name.endswith('.json'):
                json.loads(source.read_text(encoding='utf-8'))
            audio_sources.append((source, target))
    for source, target in audio_sources:
        if source.resolve() != target.resolve():
            atomic_copy(source, target)

    fast, quality = [download(chat, model) for model in CHAT_MODELS]
    # Split in an owned temporary directory so failed/incomplete output never
    # replaces the currently served set. Rebuild deterministically on each run.
    with tempfile.TemporaryDirectory(prefix='.milo-quality-', dir=chat) as staging:
        stage = Path(staging)
        subprocess.run([str(split_tool), '--split', '--split-max-size', '512M', str(quality), str(stage / 'quality')], check=True, timeout=900)
        shards = validate_shards(stage, quality)
        # Publish the first shard last, after every later shard is in place.
        for shard in [*shards[1:], shards[0]]:
            atomic_copy(shard, chat / shard.name)

    served_shards = validate_shards(chat, quality)
    manifest = {
        'fast': describe(fast, base),
        'quality': {'urls': [describe(path, base)['url'] for path in served_shards],
                    'sha256': [digest(path) for path in served_shards],
                    'bytes': sum(path.stat().st_size for path in served_shards),
                    'sourceSha256': CHAT_MODELS[1][-1]},
        'audio': [describe(target, base) for _, target in audio_sources],
    }
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=base, prefix='.manifest-', delete=False) as handle:
        manifest_temp = Path(handle.name)
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    try:
        manifest_temp.chmod(0o644)
        os.replace(manifest_temp, base / 'manifest.json')
    finally:
        manifest_temp.unlink(missing_ok=True)
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == '__main__':
    main()
