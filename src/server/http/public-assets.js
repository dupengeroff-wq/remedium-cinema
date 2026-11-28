import path from 'node:path';
import {publicDir} from '../paths.js';
import {catalogPosters} from '../modules/watch/media.js';
import {browserThemeContract} from '../modules/profiles/theme-contract.js';
import {createPublicTextStore} from './public-text.js';

const publicFiles = Object.freeze({
  "account.js": "js/core/account.js",
  "navigation.js": "js/core/navigation.js",
  "cinema-ui.js": "js/cinema/cinema-ui.js",
  "app.js": "js/cinema/app.js",
  "social.js": "js/social/social.js",
  "player.css": "css/pages/player.css",
  "social.css": "css/pages/social.css",
  "profile-themes.css": "css/themes/profile-themes.css",
  "cinema-moon.webp": "assets/profile-themes/cinema-moon.webp",
  "reconnect.js": "js/core/reconnect.js"
});

const appearanceText = Object.freeze([
  'appearance.js','stage7-viewport.js','site.css','approved-tokens.css','approved-layout.css',
  'default.css','zero-two.css','appearance-gate.css','stage6-motion.css','stage7-responsive.css','stage8-ratings.css'
]);
const catalogBody='const LOCAL_POSTERS = Object.freeze('+JSON.stringify(catalogPosters)+');';
const themeBody='window.CinemaThemeContract = '+JSON.stringify(browserThemeContract)+';';
export function publicTextInputs(){
  const files=[
    {key:'index.html',file:path.join(publicDir,'index.html')},
    {key:'social.html',file:path.join(publicDir,'social.html')},
    ...Object.entries(publicFiles).filter(([alias])=>/\.(js|css)$/.test(alias)).map(([key,file])=>({key,file:path.join(publicDir,file)})),
    ...appearanceText.map(file=>({key:'appearance:'+file,file:path.join(publicDir,'assets','profile-themes',file)})),
    {key:'auth.css',file:path.join(publicDir,'assets','auth','auth.css')}
  ];
  return {files,virtual:[{key:'catalog-posters.js',body:catalogBody,type:'js'},{key:'theme-contract.js',body:themeBody,type:'js'}]};
}
export function registerPublicAssets(app,express) {
const compressed=createPublicTextStore(publicTextInputs());
app.get(['/profile','/profile/:id','/friends','/messages','/messages/:id'],(req,res)=>{
  res.set('Cache-Control','no-cache');
  if(!compressed.send('social.html',req,res))res.sendFile(path.join(publicDir,'social.html'));
});
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if(!compressed.send('index.html',req,res))res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/catalog-posters.js',(req,res)=>{
  res.type('js').set('Cache-Control','no-cache');
  if(!compressed.send('catalog-posters.js',req,res))res.send(catalogBody);
});
app.get('/theme-contract.js',(req,res)=>{
  res.type('js').set('Cache-Control','no-cache');
  if(!compressed.send('theme-contract.js',req,res))res.send(themeBody);
});
for (const asset of ['reconnect.js','app.js','cinema-ui.js','player.css','social.js','social.css','account.js','navigation.js',
                     'cinema-moon.webp','profile-themes.css','profile-theme-kitty.webp','profile-theme-clouds.webp']) {
  app.get('/' + asset, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    if(!compressed.send(asset,req,res))res.sendFile(path.join(publicDir, publicFiles[asset] || asset));
  });
}
// Compress only known textual assets; fallback to the existing static handler.
app.get('/assets/profile-themes/:file',(req,res,next)=>{
  if(!appearanceText.includes(req.params.file))return next();
  res.set('Cache-Control','public, max-age=86400');
  if(!compressed.send('appearance:'+req.params.file,req,res))return next();
});
app.get('/assets/auth/auth.css',(req,res,next)=>{
  res.set('Cache-Control','public, max-age=0');
  if(!compressed.send('auth.css',req,res))return next();
});
// Some existing checkouts have four leading spaces in the auth directory name.
for (const directory of ['auth', '    auth']) {
  app.use('/assets/auth', express.static(path.join(publicDir, 'assets', directory), {
    index: false, dotfiles: 'deny', maxAge: 0
  }));
}
app.use('/assets/profile-themes',express.static(path.join(publicDir,'assets','profile-themes'),{
  index:false,dotfiles:'deny',maxAge:'1d'
}));
app.get('/posters/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-z0-9][a-z0-9-]*\.webp$/i.test(filename)) return res.sendStatus(404);
  res.sendFile(path.join(publicDir, 'posters', filename), {maxAge: '1d'}, error => {
    if (error && !res.headersSent) res.sendStatus(error.status === 404 ? 404 : 500);
  });
});

}
