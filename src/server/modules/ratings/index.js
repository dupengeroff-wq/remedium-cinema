import {query} from '../../db/pool.js';
import {requireUser} from '../auth/index.js';
import {limiter,ensure} from '../../http/helpers.js';
import {saveRating} from './core.js';

export function mountRatings(app,io) {
  const rate=limiter(40,60000,req=>req.user.id);
  app.put('/api/watch-history/:id/rating',requireUser(async (req,res)=>{
    rate(req);
    ensure(req.body?.userId===req.user.id,409,'Аккаунт изменился. Обнови страницу.');
    const result=await saveRating({query},req.user.id,req.params.id,req.body);
    // Notify only the owner's authenticated devices, with no rating payload.
    io.to('user:'+req.user.id).emit('film-rating-updated');
    res.json(result);
  }));
}
