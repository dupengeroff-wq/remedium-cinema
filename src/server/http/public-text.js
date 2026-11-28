// Compression only for an explicit public, credential-independent set of text
// assets. No API or user content ever passes through this module.
import {readFileSync} from 'node:fs';
import {gzipSync,brotliCompressSync,constants} from 'node:zlib';
import path from 'node:path';

export function textVariants(bytes) {
  const source=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  if(source.length<1024)return null;
  const br=brotliCompressSync(source,{params:{
    [constants.BROTLI_PARAM_MODE]:constants.BROTLI_MODE_TEXT,
    [constants.BROTLI_PARAM_QUALITY]:4,
    [constants.BROTLI_PARAM_SIZE_HINT]:source.length
  }});
  const gzip=gzipSync(source,{level:6});
  return {sourceLength:source.length,br:br.length<source.length?br:null,gzip:gzip.length<source.length?gzip:null};
}

export function createPublicTextStore({files=[],virtual=[]}={}) {
  const variants=new Map();
  // Bounded by the explicit list of public routes, never a request-driven cache.
  for(const {key,file,type} of files) {
    let bytes;
    try{bytes=readFileSync(file)}catch(error){if(error.code==='ENOENT')continue;throw error}
    const value=textVariants(bytes);
    if(value)variants.set(key,{...value,type:type||path.extname(file).slice(1)});
  }
  for(const {key,body,type} of virtual){
    const value=textVariants(body);if(value)variants.set(key,{...value,type});
  }
  function send(key,req,res){
    const item=variants.get(key);
    if(!item)return false;
    // Set Vary on the identity fallback too; do not apply to unrelated routes.
    if(typeof res.vary==='function')res.vary('Accept-Encoding');
    else res.set('Vary','Accept-Encoding');
    if(req.headers?.range||typeof req.acceptsEncodings!=='function')return false;
    const supported=['br','gzip'].filter(encoding=>item[encoding]);
    const encoding=req.acceptsEncodings(...supported,'identity');
    if(!supported.includes(encoding))return false;
    res.type(item.type).set('Content-Encoding',encoding).send(item[encoding]);
    return true;
  }
  return {send,stats:()=>[...variants.entries()].map(([key,v])=>({key,source:v.sourceLength,br:v.br?.length??v.sourceLength,gzip:v.gzip?.length??v.sourceLength}))};
}
