import {query} from '../db/pool.js';
import {sameOrigin,apiErrors} from './helpers.js';
import {mountAuth} from '../modules/auth/index.js';
import {mountProfiles} from '../modules/profiles/index.js';
import {mountMessages} from '../modules/messages/index.js';
import {mountAvatars} from '../modules/avatars/index.js';
import {mountRatings} from '../modules/ratings/index.js';
import {mountFilmCovers} from '../modules/covers/index.js';

export function registerHttp(app,io,express) {
app.use((_, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict document embedding and plugin objects without blocking the existing
  // inline UI or supported video frames. Full script CSP needs isolated browser QA.
  res.set('X-Frame-Options','DENY');
  res.set('Content-Security-Policy',"frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  next();
});
app.use('/api',(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!sameOrigin(req)) {
    return res.status(403).json({error:'Открой сайт и повтори действие.'});
  }
  next();
});
app.use('/api',express.json({limit:'24kb'}));
mountAuth(app,session=>io.in('session:'+session).disconnectSockets(true));
mountProfiles(app,io);
mountMessages(app,io);
mountAvatars(app);
mountFilmCovers(app,io);
mountRatings(app,io);
app.use(apiErrors);
app.get('/health',(_,res)=>res.json({ok:true}));
app.get('/ready',async (_,res)=>{
  try { await query('SELECT 1'); res.json({ok:true}); }
  catch { res.status(503).json({ok:false}); }
});
}
