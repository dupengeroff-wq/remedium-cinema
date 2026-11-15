const realFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input);
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
