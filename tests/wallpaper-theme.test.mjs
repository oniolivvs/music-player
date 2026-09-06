import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteFromPixels, contrastRatio } from '../src/artwork-theme.mjs';
const pixels = (r,g,b) => new Uint8ClampedArray(Array.from({length:64},()=>[r,g,b,255]).flat());
for (const [name,color,dark] of [['white',[255,255,255],true],['black',[0,0,0],false],['pale green',[216,244,219],true]]) {
  test(`normal ${name} wallpaper selects readable text`,()=>{
    const p=paletteFromPixels(pixels(...color),{allowNeutral:true});
    assert.equal(p.text.r<80,dark);assert.ok(contrastRatio(p.text,p.panel)>=4.5);
  });
}
test('normal wallpaper respects explicit light and dark text choices',()=>{
  for(const mode of ['light','dark']) {
    const p=paletteFromPixels(pixels(210,160,80),{allowNeutral:true,textMode:mode});
    assert.equal(p.text.r<80,mode==='dark');
  }
});
test('dimming a white wallpaper switches to readable light text',()=>{
  const p=paletteFromPixels(pixels(255,255,255),{allowNeutral:true,dim:90});
  assert.ok(p.text.r>200);assert.ok(contrastRatio(p.text,p.panel)>=4.5);
});
