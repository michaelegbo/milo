import {test, expect} from '@playwright/test';
test.use({baseURL:process.env.MILO_DEVICE_TEST_URL || 'http://127.0.0.1:5175'});
test.skip(!process.env.MILO_DEVICE_TEST_URL, 'Device browser suite');

test('saved files survive reload, show reuse, and detect deletion without a downloaded flag', async ({page},testInfo)=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const {AUDIO_FILES,audioFileUrl}=await import('/src/device/saved-downloads.ts' as string);
    const cache=await caches.open('transformers-cache');
    for(const {model,files} of Object.values(AUDIO_FILES) as any[]) for(const file of files) await cache.put(audioFileUrl(model,file),new Response('cached test data',{headers:{'Content-Length':'16'}}));
  });
  await page.reload();
  await expect(page.getByRole('button',{name:/Start saved voice/})).toBeEnabled();
  await expect(page.locator('#device-saved-status')).toContainText('Listening: saved');
  await page.setViewportSize({width:390,height:844});
  await page.locator('#device-setup').screenshot({path:testInfo.outputPath('saved-downloads-mobile.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(async()=>{
    const {AUDIO_FILES,audioFileUrl}=await import('/src/device/saved-downloads.ts' as string);
    await(await caches.open('transformers-cache')).delete(audioFileUrl(AUDIO_FILES.tts.model,'config.json'));
  });
  await page.getByRole('button',{name:'Check saved downloads'}).click();
  await expect(page.getByRole('button',{name:/Download missing files/})).toBeEnabled();
  await expect(page.locator('#device-saved-status')).toContainText('Voice: partly saved');
  await page.getByRole('button',{name:'Delete downloaded models',exact:true}).click();
  await page.getByRole('button',{name:'Delete models',exact:true}).click();
  await expect(page.locator('#device-saved-status')).toContainText('Voice: not saved');
  await page.reload();
  await expect(page.getByRole('button',{name:/Download & start voice/})).toBeEnabled();
});

test('real cache manager reuses complete Fast beside interrupted Quality and fetches only missing shards',async({page})=>{
  await page.goto('/');
  let gets=0;
  await page.route('**/models/chat/*.gguf',route=>{
    if(route.request().method()==='GET')gets++;
    return route.fulfill({status:200,headers:{'Content-Length':'16','Content-Type':'application/octet-stream'},body:Buffer.from('test model bytes')});
  });
  const result=await page.evaluate(async()=>{
    const {ModelManager}=await import('/node_modules/@wllama/wllama/esm/index.js' as string);
    const {reopenOrDownload}=await import('/src/device/chat-cache.ts' as string);
    const manager=new ModelManager();
    const urls=['/models/chat/fast.gguf',...Array.from({length:4},(_,i)=>`/models/chat/quality-${String(i+1).padStart(5,'0')}-of-00005.gguf`)];
    for(const path of urls){
      const url=new URL(path,location.origin).href;
      await manager.cacheManager.write(await manager.cacheManager.getNameFromURL(url),new Blob(['test model bytes']).stream(),{originalURL:url,originalSize:16,etag:'test'});
    }
    const model=await reopenOrDownload(manager,new URL(urls[0],location.origin).href);
    return {size:model.size,text:await(await model.open())[0].text()};
  });
  expect(result).toEqual({size:16,text:'test model bytes'});expect(gets).toBe(0);
  await page.evaluate(async()=>{
    const {ModelManager}=await import('/node_modules/@wllama/wllama/esm/index.js' as string);
    const {reopenOrDownload}=await import('/src/device/chat-cache.ts' as string);
    await reopenOrDownload(new ModelManager(),new URL('/models/chat/quality-00001-of-00005.gguf',location.origin).href);
  });
  expect(gets).toBe(1);
  await page.reload();
  await expect(page.locator('#device-saved-status')).toContainText('Better replies: saved');
  await page.evaluate(async()=>{
    const {ModelManager}=await import('/node_modules/@wllama/wllama/esm/index.js' as string);
    const {reopenOrDownload}=await import('/src/device/chat-cache.ts' as string);
    await reopenOrDownload(new ModelManager(),new URL('/models/chat/quality-00001-of-00005.gguf',location.origin).href);
  });
  expect(gets).toBe(1);
});
