import { createApp } from './app.mjs';
const port=Number(process.env.PORT||5173),host=process.env.HOST||'127.0.0.1',origin=process.env.PUBLIC_ORIGIN||`http://localhost:${port}`;
const app=createApp({origin,allowSimulator:process.env.ALLOW_SIMULATOR!=='false'});
app.server.listen(port,host,()=>console.log(`NearBank × NearKey Lite\n${origin}\nFictional money only.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>process.exit(0)));
