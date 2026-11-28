import express from 'express';
import {createServer} from 'node:http';
import {Server} from 'socket.io';
import {close as closeDatabase} from './db/pool.js';
import {installRealtime} from './realtime/index.js';
import {registerHttp} from './http/app.js';
import {registerPublicAssets} from './http/public-assets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
const http = createServer(app);
const io = new Server(http, {maxHttpBufferSize: 100_000});
const {shutdown}=installRealtime(io,closeDatabase);
registerHttp(app,io,express);
registerPublicAssets(app,express);

const port = Number(process.env.PORT) || 3000;
http.listen(port, '0.0.0.0', () => console.log('REMEDIUM CINEMA COSMOS listening on ' + port));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
