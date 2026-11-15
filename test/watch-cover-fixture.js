const realFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input);
  if(url.origin==='https://www.youtube.com'&&url.pathname==='/oembed'){
    const id=new URL(url.searchParams.get('url')).searchParams.get('v');
    return id==='LegacySrc01'
      ?Response.json({type:'video',title:'Выход 8'})
      :new Response('{}',{status:404});
  }
  if(url.origin==='https://api.vk.com'&&url.pathname==='/method/video.get'){
    const videos=options.body?.get('videos');
    if(options.body?.get('access_token')!=='vk-test-only')return new Response('{}',{status:403});
    const items=videos==='-987_654'?[{owner_id:-987,id:654,title:'Видео с подтверждённой обложкой',
      image:[{url:'https://images.example.org/vk-thumbnail.jpg',width:800}]}]:[];
    return Response.json({response:{items}});
  }
  if(url.origin!=='https://api.themoviedb.org') return realFetch(input,options);
  if(options.headers?.Authorization!=='Bearer tmdb-test-only') return new Response('{}',{status:401});
  const movie={id:42,title:'Проверяемый фильм',release_date:'2019-01-24',poster_path:'/fixture.jpg'};
  if(url.pathname==='/3/search/movie'){
    const results=url.searchParams.get('query')==='Проверяемый фильм'&&url.searchParams.get('include_adult')==='false'?[movie]:[];
    return Response.json({results});
  }
  if(url.pathname==='/3/movie/42') return Response.json(movie);
  return new Response('{}',{status:404});
};
