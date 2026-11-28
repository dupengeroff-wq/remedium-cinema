export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function ensure(condition,status,message) {
  if (!condition) throw new HttpError(status,message);
}
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export const text = (value,max) => typeof value === 'string' ? value.trim().slice(0,max) : '';
export const pair = (a,b) => [a,b].sort();

export function wrap(handler) {
  return (req,res,next) => Promise.resolve().then(() => handler(req,res,next)).catch(next);
}

export function expectedOrigin(req) {
  const configured = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  return configured ? new URL(configured).origin : (process.env.NODE_ENV === 'test' ? 'http://' : 'https://') + req.headers.host;
}

export function sameOrigin(req, requireHeader = true) {
  const origin = req.headers.origin;
  return origin ? origin === expectedOrigin(req) : !requireHeader;
}

export function apiErrors(error,req,res,next) {
  if (res.headersSent || !req.path.startsWith('/api/')) return next(error);
  if (error instanceof HttpError) return res.status(error.status).json({error:error.message});
  if (error.type === 'entity.too.large') return res.status(413).json({error:'Файл или запрос слишком большой.'});
  if (error.type === 'entity.parse.failed') return res.status(400).json({error:'Некорректный запрос.'});
  console.warn('API error:',error.code || error.name);
  res.status(503).json({error:'Сервис временно недоступен. Попробуй ещё раз.'});
}

export function limiter(max,windowMs,keyOf) {
  const entries = new Map();
  return req => {
    const now = Date.now();
    if (entries.size > 2048) {
      for (const [key,value] of entries) if (value.until <= now) entries.delete(key);
    }
    const key = keyOf(req);
    let entry = entries.get(key);
    if (!entry || entry.until <= now) {
      ensure(entries.size < 4096 || entries.has(key),429,'Попробуй немного позже.');
      entry = {count:0,until:now+windowMs};
      entries.set(key,entry);
    }
    ensure(++entry.count <= max,429,'Слишком много попыток. Попробуй позже.');
  };
}
