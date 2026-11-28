// Socket.IO automatically resumes transport failures when socket.active is true.
// Only an inactive socket needs a manual reconnect, after confirming account identity.
(() => {
  function create({socket,getAccount,verify,onInvalid,onChanged,onStatus=()=>{},
    setTimer=setTimeout,clearTimer=clearTimeout}) {
    let generation=0,timer=null,running=false,attempt=0,suspended=false;
    function reset() {
      generation++;
      if(timer!==null)clearTimer(timer);
      timer=null;running=false;attempt=0;
    }
    function suspend(){suspended=true;reset();}
    function resume(){suspended=false;}
    function connected(){reset();}
    function schedule(){
      if(suspended||!getAccount()?.id||socket.connected||socket.active||timer!==null||running)return;
      const version=generation;
      const delay=Math.min(1000*2**Math.min(attempt++,4),16000);
      timer=setTimer(async()=>{
        timer=null;running=true;
        const expected=getAccount()?.id;
        const current=()=>version===generation && !suspended && getAccount()?.id===expected;
        try{
          const {user}=await verify();
          if(!current())return;
          if(!user){suspend();onInvalid();return;}
          if(user.id!==expected){suspend();onChanged();return;}
          if(!socket.connected&&!socket.active)socket.connect();
        }catch(error){
          if(current()){
            if(error.status===401){suspend();onInvalid();return;}
            onStatus('Связь пока недоступна. Повторяем подключение…');
          }
        }finally{
          if(version===generation){running=false;schedule();}
        }
      },delay);
    }
    return Object.freeze({schedule,suspend,resume,connected});
  }
  window.CinemaReconnect=Object.freeze({create});
})();
