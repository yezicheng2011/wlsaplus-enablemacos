/* Native bridge fixture used only by this browser test. No credentials or live nodes. */
(() => {
  'use strict';
  let currentVPN={state:'error',connected:false,cleanupRequired:true,canDisconnect:false}, disconnectCalls=0;
  const failures=[],passed=[];
  const state=()=>({school:{},snapshot:{courses:[],schedule:[],assignments:[],attendance:[]},todos:[],vpn:currentVPN});
  window.webkit={messageHandlers:{wlsaplus:{postMessage({id,method}){
    let result,error;
    if(method==='app.state')result=state();
    else if(method==='vpn.nodes')result={nodes:[],selectedNode:''};
    else if(method==='vpn.disconnect'){disconnectCalls++;currentVPN={state:'disconnected',connected:false,cleanupRequired:false,canDisconnect:false};result=currentVPN;}
    else error='Unexpected native method in recovery test.';
    queueMicrotask(()=>window.nativeReply({id,result,error}));
  }}}};
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const wait=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Browser recovery state did not settle.');};
  window.addEventListener('load',()=>{
    (async()=>{
      await wait(()=>document.querySelector('[data-action="open-tool"][data-value="vpn"]') || document.querySelector('a[href="#tools"]'));
      document.querySelector('a[href="#tools"]').click();
      await wait(()=>document.querySelector('[data-action="open-tool"][data-value="vpn"]'));
      document.querySelector('[data-action="open-tool"][data-value="vpn"]').click();
      await wait(()=>!document.querySelector('[data-action="vpn-nodes"]')?.disabled);
      for(const [name,vpn] of [
        ['cleanup-required',{state:'error',connected:false,cleanupRequired:true,canDisconnect:false}],
        ['retained-helper',{state:'error',connected:false,cleanupRequired:false,canDisconnect:true}]
      ]){
        disconnectCalls=0;currentVPN=vpn;window.nativeEvent({name:'vpn',value:currentVPN});
        const button=document.querySelector('[data-action="vpn-disconnect"]');
        check(button && button.textContent==='Recover network',name+': must render the recovery action.');
        check(!button.disabled,name+': recovery must remain enabled without a selected node.');
        check(!document.querySelector('[data-action="vpn-connect"]'),name+': must not offer Connect while recovery is needed.');
        button.click();
        await wait(()=>document.querySelector('[data-action="vpn-connect"]'));
        check(disconnectCalls===1,name+': recovery must dispatch vpn.disconnect exactly once.');
        check(document.querySelector('[data-action="vpn-connect"]').disabled,name+': ordinary Connect must remain disabled when no node is selected.');
        passed.push(name);
      }
    })().catch(error=>failures.push(error.message)).finally(()=>{
      const report=document.createElement('script');report.id='vpn-recovery-test-results';report.type='application/json';report.textContent=JSON.stringify({passed:passed.length,tests:passed,failures});document.body.append(report);
    });
  });
})();
