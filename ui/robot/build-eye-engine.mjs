import { readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync(new URL('./eyes-adapter.js', import.meta.url),'utf8')
writeFileSync(new URL('./eyes-engine.html',import.meta.url), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{color-scheme:only light;margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style></head><body><script>${source.replaceAll('</script','<\\/script')}</script></body></html>`)
