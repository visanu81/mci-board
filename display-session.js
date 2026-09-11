// Messages are accepted once, only from the exact companion window and origin.
export function connectDisplayParent({host=window,popup,nonce,issueToken,onError,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let active=true,received=false;
  const dispose=()=>{active=false;host.removeEventListener('message',ready);clearTimer(timer);};
  const fail=message=>{if(!active)return;dispose();onError(message);};
  const ready=async event=>{
    if(!active || received || event.origin!==host.location.origin || event.source!==popup || event.data?.type!=='mci-display-ready' || event.data.nonce!==nonce)return;
    received=true;host.removeEventListener('message',ready);
    try{
      const result=await issueToken();
      if(!active)return;
      if(popup.closed || typeof result.token!=='string')throw Error('표출 창 연결이 끊겼습니다. 다시 열어주세요.');
      popup.postMessage({type:'mci-display-token',nonce,token:result.token},host.location.origin);
      dispose();
    }catch(error){fail(error.message || '표출 연결에 실패했습니다. 다시 열어주세요.');}
  };
  const timer=setTimer(()=>fail('표출 창 연결 시간이 초과됐습니다. 팝업 허용과 인터넷 연결을 확인한 뒤 다시 열어주세요.'),30000);
  host.addEventListener('message',ready);
  return dispose;
}
export function connectDisplayChild({host=window,nonce,signIn,onError,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let active=true,received=false;
  const dispose=()=>{active=false;host.removeEventListener('message',accept);clearTimer(timer);};
  const fail=message=>{if(!active)return;dispose();onError(message);};
  const accept=async event=>{
    if(!active || received || event.origin!==host.location.origin || event.source!==host.opener || event.data?.type!=='mci-display-token' || event.data.nonce!==nonce || typeof event.data.token!=='string')return;
    received=true;host.removeEventListener('message',accept);
    try{await signIn(event.data.token);dispose();}catch{fail('표출 인증에 실패했습니다. 입력 창에서 다시 열어주세요.');}
  };
  const timer=setTimer(()=>fail('표출 연결이 지연되고 있습니다. 입력 창에서 표출 창을 다시 열어주세요.'),45000);
  if(!host.opener || !nonce){fail('입력 창의 표출 버튼으로 다시 열어주세요.');return dispose;}
  host.addEventListener('message',accept);
  host.opener.postMessage({type:'mci-display-ready',nonce},host.location.origin);
  return dispose;
}
