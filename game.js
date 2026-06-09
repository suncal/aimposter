/* ===========================================================================
   AImposter — "Real or AI?" engine v3
   v2 hook stack (combo, XP/ranks, revive, achievements, daily streak, Blitz,
   juice) PLUS: difficulty-aware deck (climbing AI difficulty, balanced classes),
   URL Challenge mode, global leaderboard + real percentiles via Cloudflare
   Worker (graceful LOCAL fallback when no backend), cheat-proof guess-log.
   =========================================================================== */

const BRAND = "AImposter";
const SHARE_URL = "suncal.github.io/aimposter";
const API_BASE = "";              // <- set to your Worker URL to go global. "" = local mode.
const DAILY_LEN = 10, CH_LEN = 10, START_LIVES = 3, BLITZ_SECONDS = 60, BASE_POINTS = 100;

const $ = (s) => document.querySelector(s);
const store = {
  get(k,d){ try{ const v=localStorage.getItem("ai_"+k); return v===null?d:JSON.parse(v); }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem("ai_"+k, JSON.stringify(v)); }catch{} },
  add(k,n){ const v=(store.get(k,0)||0)+n; store.set(k,v); return v; },
};

let ROUNDS=[], state=null, adRefreshCount=0, blitzTimer=null, seen={}, seenCtr=0;
let selectedMode="daily", pendingChallenge=null, pendingDaily=null, boxReady=false;
const now=()=>Date.now();

/* ---------- ACHIEVEMENTS ---------- */
const ACHIEVEMENTS=[
  {id:"first",icon:"🎯",name:"First Catch",tip:"Spot your first AI"},
  {id:"streak10",icon:"🔥",name:"On Fire",tip:"10 correct in a row"},
  {id:"streak20",icon:"🧠",name:"Untouchable",tip:"20 correct in a row"},
  {id:"perfect",icon:"💎",name:"Flawless",tip:"Perfect daily challenge"},
  {id:"marathon",icon:"🏃",name:"Marathon",tip:"50 rounds in one run"},
  {id:"quick",icon:"⚡",name:"Quickdraw",tip:"5 fast correct in a run"},
  {id:"lvl5",icon:"🕵️",name:"Detective",tip:"Reach level 5"},
  {id:"phoenix",icon:"🦅",name:"Phoenix",tip:"Revive, then hit a 5 streak"},
  {id:"blitzace",icon:"🚀",name:"Blitz Ace",tip:"Score 3,000+ in Blitz"},
  {id:"win",icon:"🏆",name:"Duelist",tip:"Win a friend challenge"},
];

/* ---------- LEVELS / RANKS ---------- */
function levelFromXP(xp){ let lvl=1,acc=0,need=250; while(xp>=acc+need){acc+=need;lvl++;need=Math.round(need*1.25);} return {level:lvl,into:xp-acc,span:need,pct:Math.min(100,Math.round((xp-acc)/need*100))}; }
function rankFor(l){ return l>=21?"Spectre":l>=15?"AI Hunter":l>=10?"Special Agent":l>=6?"Detective":l>=3?"Junior Sleuth":"Rookie Spotter"; }

/* ---------- SOUND ---------- */
let actx=null;
function snd(type){ if(!store.get("soundOn",true)) return;
  try{ actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    const seq={win:[660,880],lose:[180,120],level:[523,659,784,1046],ach:[988,1318],tick:[440]}[type]||[440];
    seq.forEach((f,i)=>{ const o=actx.createOscillator(),g=actx.createGain(); o.type=type==="lose"?"sawtooth":"sine"; o.frequency.value=f;
      const t=actx.currentTime+i*0.08; g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.18,t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,t+0.14);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t+0.16); }); }catch{} }

/* ---------- shuffle / seed ---------- */
function mulberry32(s){ return function(){ let t=s+=0x6D2B79F5; t=Math.imul(t^t>>>15,t|1); t^=t+Math.imul(t^t>>>7,t|61); return ((t^t>>>14)>>>0)/4294967296; }; }
function shuffle(a,rng){ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor((rng?rng():Math.random())*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function todaySeed(){ const d=new Date(); return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate(); }
function todayKey(){ const d=new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function dateKey(d){ return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }

/* ---------- DECK BUILDER (climbing AI difficulty, balanced classes) ---------- */
// AI in ascending difficulty. With `limit`, SPREAD across tiers (so a short
// fixed deck still ramps easy->med->hard instead of being all-easy).
function aiAscending(rng, limit){
  const tiers={1:[],2:[],3:[]};
  shuffle(ROUNDS.filter(r=>r.isAI),rng).forEach(r=>tiers[r.diff||2].push(r));
  if(!limit) return [...tiers[1],...tiers[2],...tiers[3]];
  const out=[], want=i=>{ const f=i/Math.max(1,limit); return f<0.45?1:f<0.8?2:3; };
  for(let i=0;i<limit;i++){ const t=want(i); const r=tiers[t].pop()||tiers[2].pop()||tiers[1].pop()||tiers[3].pop(); if(r) out.push(r); }
  return out;
}
// NEVER-REPEAT ordering: unseen images first (random), then least-recently-seen.
// With the auto-generation pipeline growing the pool, the unseen set never runs
// dry — so a player effectively never sees the same image twice.
function freshFirst(list){
  const unseen = shuffle(list.filter(r=>seen[r.id]===undefined));
  const used   = list.filter(r=>seen[r.id]!==undefined).sort((a,b)=>seen[a.id]-seen[b.id]);
  return unseen.concat(used);
}
function markSeen(id){ seen[id]=++seenCtr; store.set("seen",seen); store.set("seenCtr",seenCtr); }

function buildDeckGeneric(n, rng, fixed){
  let ai, realsAll;
  if(fixed){                                  // daily/challenge: seeded + difficulty spread (deterministic, shared)
    ai = aiAscending(rng, Math.round(n*0.5));
    realsAll = shuffle(ROUNDS.filter(r=>!r.isAI), rng);
  } else {                                    // endless/blitz: take FRESHEST unseen, then ramp by difficulty
    ai = freshFirst(ROUNDS.filter(r=>r.isAI)).slice(0, 120).sort((a,b)=>(a.diff||2)-(b.diff||2));
    realsAll = freshFirst(ROUNDS.filter(r=>!r.isAI));
  }
  const reals = fixed ? realsAll.slice(0, Math.max(0, n-ai.length))
                      : realsAll.slice(0, Math.min(realsAll.length, ai.length + 6)); // ~50/50
  const pattern = shuffle([...ai.map(()=>"a"), ...reals.map(()=>"r")], rng);          // unpredictable class order
  const seq=[]; let a=0,re=0;
  for(const c of pattern){ if(seq.length>=n) break;
    if(c==="a"&&a<ai.length) seq.push(ai[a++]); else if(re<reals.length) seq.push(reals[re++]); else if(a<ai.length) seq.push(ai[a++]); }
  return seq;
}
function buildSequence(n,rng){ return buildDeckGeneric(n,rng,false); } // endless/blitz: full ramp over the session
function buildFixed(n,rng){ return buildDeckGeneric(n,rng,true); }     // daily/challenge: spread + ramp in 10

/* ---------- API (graceful local fallback) ---------- */
const api={
  on(){ return !!API_BASE; },
  async post(path,body){ const r=await fetch(API_BASE+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); return r.json(); },
  async get(path){ const r=await fetch(API_BASE+path); return r.json(); },
};
// local percentile estimates (clearly labelled "est.") until the backend is on
const DAILY_PCTL=[1,3,8,16,28,43,60,76,88,95,99];
function estPercentile(mode,score,total){
  if(mode==="daily"||mode==="challenge"){ return DAILY_PCTL[Math.max(0,Math.min(10,Math.round(score/(total||10)*10)))]; }
  const pts=[[0,5],[500,30],[1000,50],[2000,70],[4000,85],[8000,95],[15000,99]];
  for(let i=1;i<pts.length;i++){ if(score<pts[i][0]){ const[a,b]=pts[i-1],[c,d]=pts[i]; return Math.round(b+(d-b)*(score-a)/(c-a)); } }
  return 99;
}

function refreshAllAds(){ adRefreshCount++; document.querySelectorAll(".ad-rail").forEach(el=>{ const tag=el.dataset.ad.toUpperCase(); el.innerHTML=`<div><span class="ad-tag">AD · ${tag}</span><span class="ad-count">impression #${adRefreshCount}</span></div>`; }); }
function show(id){ ["start","game","result"].forEach(s=>$("#screen-"+s).classList.toggle("hidden",s!==id)); document.body.classList.toggle("playing", id==="game"); }
function toast(msg){ const w=$("#toast-wrap"),t=document.createElement("div"); t.className="toast"; t.textContent=msg; w.appendChild(t); setTimeout(()=>t.remove(),2600); }
function confetti(){ const c=$("#confetti"),cols=["#7c5cff","#39d0ff","#2fd27a","#ffd54a","#ff5470"]; for(let i=0;i<36;i++){ const p=document.createElement("i"); p.style.left=Math.random()*100+"%"; p.style.background=cols[i%cols.length]; p.style.animationDuration=(1.4+Math.random()*1.2)+"s"; p.style.animationDelay=(Math.random()*0.2)+"s"; c.appendChild(p); setTimeout(()=>p.remove(),2800);} }
function popPoints(txt){ const fx=$("#fx"),p=document.createElement("div"); p.className="pop"; p.textContent=txt; fx.appendChild(p); setTimeout(()=>p.remove(),1000); }

function unlock(id){ const got=store.get("ach",{}); if(got[id]) return; got[id]=true; store.set("ach",got); const a=ACHIEVEMENTS.find(x=>x.id===id); if(a){ toast(`${a.icon} Badge unlocked: ${a.name}`); snd("ach"); if(state) state.newAch.push(a);} }

/* ---------- START SCREEN ---------- */
function renderStart(){
  const xp=store.get("xp",0), L=levelFromXP(xp);
  $("#rank-title").textContent=rankFor(L.level); $("#rank-level").textContent="Lv "+L.level;
  $("#xpfill").style.width=L.pct+"%"; $("#xp-sub").textContent=`${L.into} / ${L.span} XP`;
  const ds=store.get("dayStreak",{count:0,last:""});
  $("#daystreak").textContent=ds.count>0?`🔥 ${ds.count}-day streak — keep it alive!`:"";
  const played=store.get("totalPlayed",0), acc=played?Math.round(store.get("totalCorrect",0)/played*100):0;
  $("#start-stats").innerHTML=`<div><b>${store.get("bestStreak",0)}</b>best streak</div><div><b>${acc}%</b>accuracy</div><div><b>${store.get("bestEndless",0).toLocaleString()}</b>top score</div>`;
  const got=store.get("ach",{}); $("#ach-count").textContent=`${Object.keys(got).length}/${ACHIEVEMENTS.length}`;
  $("#ach-row").innerHTML=ACHIEVEMENTS.map(a=>`<div class="badge ${got[a.id]?"on":""}" title="${a.name} — ${a.tip}">${a.icon}</div>`).join("");
  renderLeaderboard();
  // challenge banner
  if(pendingChallenge){ const c=pendingChallenge; $("#ch-banner").classList.remove("hidden");
    $("#ch-banner").innerHTML = c.score!=null ? `🎯 <b>${esc(c.name)}</b> challenged you — beat their <b>${c.score}/${CH_LEN}</b>!` : `🎯 <b>${esc(c.name)}</b> sent you a challenge set!`;
    $("#btn-play").textContent="Accept challenge";
  } else { $("#ch-banner").classList.add("hidden"); $("#btn-play").textContent="Play"; }
  const doneToday=store.get("dailyDone","")===todayKey();
  $("#daily-note").textContent = pendingChallenge ? "Same 10 images they played. Can you beat them?"
    : selectedMode==="daily"&&doneToday ? "You beat today's challenge — replay it, or try Endless / Blitz."
    : selectedMode==="blitz" ? "60 seconds. Correct = +2s. Wrong = −3s. Go." : "New daily challenge every day. Endless never stops.";
}

async function renderLeaderboard(){
  const el=$("#lb-list"); const mode = selectedMode==="challenge"?"daily":selectedMode;
  if(api.on()){
    el.innerHTML=`<div class="lb-load">Loading global top…</div>`;
    try{ const d=await api.get(`/api/leaderboard?mode=${mode}&limit=8`);
      el.innerHTML = (d.top&&d.top.length) ? d.top.map((e,i)=>`<div class="lb-row"><span>${i+1}. ${esc(e.name)}</span><b>${(e.score||0).toLocaleString()}</b></div>`).join("")
        : `<div class="lb-load">Be the first on the board.</div>`;
    }catch{ el.innerHTML=`<div class="lb-load">Leaderboard offline.</div>`; }
  } else {
    el.innerHTML=`<div class="lb-row"><span>Endless best</span><b>${store.get("bestEndless",0).toLocaleString()}</b></div>
      <div class="lb-row"><span>⚡ Blitz best</span><b>${store.get("bestBlitz",0).toLocaleString()}</b></div>
      <div class="lb-row"><span>Daily best</span><b>${store.get("bestDaily",0)}/${DAILY_LEN}</b></div>
      <div class="lb-note">🌐 Global leaderboard activates when the backend is connected.</div>`;
  }
}

/* ---------- day streak ---------- */
function bumpDayStreak(){ const ds=store.get("dayStreak",{count:0,last:""}),t=todayKey(); if(ds.last===t) return ds.count;
  if(ds.last===yesterdayKey()) ds.count+=1;
  else if(ds.last && store.get("freeze",false)){ store.set("freeze",false); ds.count+=1; toast("🧊 Streak Freeze used — streak saved!"); }
  else ds.count=1;
  ds.last=t; store.set("dayStreak",ds);
  if(ds.count>=3) unlock("regular"); return ds.count; }

/* ---------- start a run ---------- */
function startRun(mode){
  bumpDayStreak();
  let deck, seed=null;
  if(mode==="daily"){ seed=todaySeed(); deck=buildFixed(DAILY_LEN, mulberry32(seed)); }
  else if(mode==="challenge"){ seed=pendingChallenge?pendingChallenge.seed:Math.floor(Math.random()*1e9); deck=buildFixed(CH_LEN, mulberry32(seed)); }
  else { deck=buildSequence(ROUNDS.length); }
  const bonusHints=Math.min(3, store.get("hintBank",0)); if(bonusHints) store.set("hintBank", store.get("hintBank",0)-bonusHints);
  state={ mode, deck, i:0, score:0, streak:0, lives:START_LIVES, results:[], guesses:[],
          locked:false, hints:3+bonusHints, skips:1, revived:false, reviveUsed:false, quickHits:0,
          startXP:store.get("xp",0), newAch:[], roundStart:0, timeLeft:BLITZ_SECONDS, over:false,
          seed, challenger: mode==="challenge"&&pendingChallenge?pendingChallenge:null };
  state._lvl=levelFromXP(state.startXP).level;
  show("game");
  $("#timebar").classList.toggle("hidden",mode!=="blitz");
  $("#powerups").classList.toggle("hidden",mode==="blitz");
  if(mode==="blitz") startBlitzTimer();
  refreshAllAds(); renderRound();
}

function startBlitzTimer(){ clearInterval(blitzTimer); state.timeLeft=BLITZ_SECONDS;
  blitzTimer=setInterval(()=>{ state.timeLeft-=0.1; if(state.timeLeft<=0){ state.timeLeft=0; clearInterval(blitzTimer); return endRun(); }
    $("#timefill").style.width=(state.timeLeft/BLITZ_SECONDS*100)+"%"; $("#timefill").classList.toggle("low",state.timeLeft<10);
    $("#hud-progress").textContent=`⏱ ${state.timeLeft.toFixed(1)}s`; },100); }

function renderRound(){
  const r=state.deck[state.i]; state.locked=false; state.roundStart=now();
  $("#reveal").classList.add("hidden"); $("#choices").classList.remove("hidden"); $("#btn-next").classList.add("hidden");
  $("#tip").classList.add("hidden"); $("#verdict-badge").classList.add("hidden");
  const img=$("#round-img"); img.classList.remove("img-in"); void img.offsetWidth; img.src=r.src; img.classList.add("img-in"); markSeen(r.id);
  if(state.mode!=="blitz"){ const tot=(state.mode==="daily"||state.mode==="challenge")?`/${state.deck.length}`:""; $("#hud-progress").textContent=`Round ${state.i+1}${tot}`; }
  $("#hud-score").textContent=state.score.toLocaleString();
  $("#hud-combo").textContent=state.streak>0?`🔥x${state.streak}`:"";
  $("#hud-lives").textContent=state.mode==="endless"?"❤️".repeat(Math.max(0,state.lives))+"🖤".repeat(Math.max(0,START_LIVES-state.lives)):"";
  $("#pu-hint-n").textContent=state.hints; $("#pu-skip-n").textContent=state.skips;
  $("#pu-hint").disabled=state.hints<=0; $("#pu-skip").disabled=state.skips<=0;
}

const TIPS=["Zoom in on hands and fingers — AI still fumbles them.","Check any text or signage; it usually melts.","Look at reflections and shadows for disagreements.","Examine eyes, ears and teeth for weirdness.","Backgrounds and repeated patterns often give it away."];
function useHint(){ if(state.hints<=0||state.locked) return; state.hints--; $("#pu-hint-n").textContent=state.hints; $("#pu-hint").disabled=state.hints<=0;
  const tip=$("#tip"); tip.textContent="🔎 "+TIPS[Math.floor(Math.random()*TIPS.length)]; tip.classList.remove("hidden"); }
function useSkip(){ if(state.skips<=0||state.locked) return; state.skips--; state.results.push("skip"); advance(); }

function guess(choice){
  if(state.locked) return; state.locked=true;
  const r=state.deck[state.i], correct=choice===(r.isAI?"ai":"real"), elapsed=(now()-state.roundStart)/1000;
  state.guesses.push({id:r.id,guess:choice,ms:Math.round(elapsed*1000)});
  store.add("totalPlayed",1); if(correct) store.add("totalCorrect",1);
  let points=0;
  if(correct){
    if(r.isAI) unlock("first");
    state.streak++; const mult=state.streak, speed=elapsed<3?Math.round((3-elapsed)*50):0; points=BASE_POINTS*mult+speed; state.score+=points;
    addCoins(COIN_PER_CORRECT); addLP(Math.max(1,Math.round(points/30)));
    const newXP=store.add("xp",points);
    if(elapsed<2){ state.quickHits++; if(state.quickHits>=5) unlock("quick"); }
    if(state.streak>store.get("bestStreak",0)) store.set("bestStreak",state.streak);
    if(state.streak===10) unlock("streak10"); if(state.streak===20) unlock("streak20");
    if(state.revived&&state.streak>=5) unlock("phoenix");
    checkLevelUp(newXP); state.results.push("win"); juiceWin(points,mult);
  } else { state.streak=0; if(state.mode==="endless") state.lives--; state.results.push("lose"); juiceLose(); }
  if(state.mode==="endless"&&(state.i+1)>=50) unlock("marathon");
  $("#hud-score").textContent=state.score.toLocaleString(); $("#hud-combo").textContent=state.streak>0?`🔥x${state.streak}`:"";
  if(state.mode==="blitz"){ state.timeLeft+=correct?2:-3; setTimeout(advance,500); return; }
  showReveal(correct,r,points);
}
function juiceWin(points,mult){ snd("win"); popPoints("+"+points.toLocaleString()); const w=$(".img-wrap"); w.classList.remove("flash-win"); void w.offsetWidth; w.classList.add("flash-win"); const c=$("#hud-combo"); c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump"); if(mult>0&&mult%5===0) confetti(); }
function juiceLose(){ snd("lose"); const w=$(".img-wrap"); w.classList.remove("flash-lose"); void w.offsetWidth; w.classList.add("flash-lose"); }
// % of players FOOLED by this image (deterministic per image; harder = more).
// Local estimate now; the Worker can replace it with real aggregated stats.
function foolRate(r){ const base=r.isAI?({1:34,2:50,3:68}[r.diff||3]):28; const j=(hashStr(r.id)%24)-8; return Math.max(9,Math.min(91,base+j)); }
const WIN_PHRASES=["🕵️ You caught it.","Sharp eye.","Not fooled.","Busted the fake.","Too easy?"];
const LOSE_PHRASES=["🤖 The Imposter won.","Fooled you.","Gotcha.","It slipped past.","Outsmarted."];
function showReveal(correct,r,points){
  const badge=$("#verdict-badge"); badge.textContent=correct?"✓ Correct":"✗ Wrong"; badge.className="verdict-badge "+(correct?"win":"lose"); badge.classList.remove("hidden");
  const pick=a=>a[hashStr(r.id+(correct?"w":"l"))%a.length];
  $("#reveal-verdict").textContent=correct?pick(WIN_PHRASES):pick(LOSE_PHRASES); $("#reveal-verdict").className="reveal-verdict "+(correct?"win":"lose");
  $("#reveal-points").textContent=correct?`+${points.toLocaleString()} pts  ·  🔥x${state.streak} combo`:"Combo lost.";
  $("#reveal-truth").textContent=r.isAI?"🤖 This was AI-generated.":"📷 This was a real photo.";
  const fp=foolRate(r);
  $("#reveal-social").textContent = correct
    ? (fp>=60 ? `🌍 Only ${100-fp}% spotted this — elite eye 👁` : `🌍 ${fp}% of players got fooled — you didn't.`)
    : `🌍 Don't feel bad — ${fp}% missed this one too.`;
  $("#reveal-fact").textContent=r.fact||""; $("#choices").classList.add("hidden"); $("#reveal").classList.remove("hidden"); $("#btn-next").classList.remove("hidden");
}
function checkLevelUp(newXP){ const cur=levelFromXP(newXP).level; if(cur>state._lvl){ state._lvl=cur; toast(`⭐ Level ${cur} — ${rankFor(cur)}!`); snd("level"); confetti(); if(cur>=5) unlock("lvl5"); } }

function advance(){ if(!state||state.over) return; state.i++;
  if(state.mode==="endless"&&state.lives<=0){ return state.reviveUsed?endRun():offerRevive(); }
  if((state.mode==="daily"||state.mode==="challenge")&&state.i>=state.deck.length) return endRun();
  if(state.i>=state.deck.length){ const last=state.deck[state.deck.length-1];
    state.deck=buildSequence(ROUNDS.length);
    if(last&&state.deck[0]&&state.deck[0].id===last.id&&state.deck.length>1){ const t=state.deck[0]; state.deck[0]=state.deck[1]; state.deck[1]=t; }
    state.i=0; }
  if(state.mode!=="blitz") refreshAllAds();
  renderRound();
}
function next(){ advance(); }

function offerRevive(){ $("#revive-line").textContent=`You're on ${state.score.toLocaleString()} pts. Revive and keep the run alive?`;
  const tk=store.get("reviveTokens",0), tb=$("#btn-revive-token"); tb.classList.toggle("hidden",tk<=0); if(tk>0) tb.textContent=`❤️ Use Revive Token (${tk})`;
  $("#revive-overlay").classList.remove("hidden"); }
function reviveNow(){ state.lives=1; state.reviveUsed=true; state.revived=true; refreshAllAds(); renderRound(); }
function doReviveToken(){ if(store.get("reviveTokens",0)<=0) return; store.set("reviveTokens",store.get("reviveTokens",0)-1); $("#revive-overlay").classList.add("hidden"); reviveNow(); }
function doRevive(){ $("#revive-overlay").classList.add("hidden"); let c=3; $("#ad-count").textContent=c; $("#ad-overlay").classList.remove("hidden");
  const iv=setInterval(()=>{ c--; $("#ad-count").textContent=c; if(c<=0){ clearInterval(iv); $("#ad-overlay").classList.add("hidden"); reviveNow(); } },1000); }

/* ---------- end run + score submit ---------- */
async function endRun(){
  clearInterval(blitzTimer); state.over=true;
  const total=state.results.length, right=state.results.filter(r=>r==="win").length;
  const fixed = state.mode==="daily"||state.mode==="challenge";

  if(state.mode==="daily"){ store.set("dailyDone",todayKey()); if(right>store.get("bestDaily",0)) store.set("bestDaily",right); if(right===total&&total>0) unlock("perfect");
    $("#result-title").textContent="Daily challenge complete"; $("#result-score").textContent=`${right}/${total}`;
  } else if(state.mode==="challenge"){
    $("#result-title").textContent="Challenge complete"; $("#result-score").textContent=`${right}/${total}`;
  } else if(state.mode==="blitz"){ if(state.score>3000) unlock("blitzace"); if(state.score>store.get("bestBlitz",0)) store.set("bestBlitz",state.score);
    $("#result-title").textContent="⚡ Blitz over"; $("#result-score").textContent=state.score.toLocaleString();
  } else { if(state.score>store.get("bestEndless",0)) store.set("bestEndless",state.score);
    $("#result-title").textContent="Run over"; $("#result-score").textContent=state.score.toLocaleString(); }

  $("#result-grid").textContent = fixed ? state.results.map(r=>r==="win"?"🟩":r==="skip"?"🟨":"🟥").join("") : "";

  // challenge comparison
  const cmp=$("#ch-compare"); cmp.textContent="";
  if(state.mode==="challenge"&&state.challenger&&state.challenger.score!=null){
    const me=right, them=state.challenger.score;
    cmp.textContent = me>them?`🏆 You beat ${esc(state.challenger.name)} — ${me} vs ${them}!` : me===them?`🤝 Tied with ${esc(state.challenger.name)} — ${me} vs ${them}.` : `😤 ${esc(state.challenger.name)} won — ${me} vs ${them}. Rematch?`;
    if(me>them) unlock("win");
  }

  // default line
  $("#result-line").textContent = fixed ? (right===total?"Flawless. You can't be fooled.":right>=total*0.7?"Sharp eye — better than most.":"AI got you a few times.") :
    (state.mode==="blitz" ? "Speed run logged." : "Run logged.");

  const gained=store.get("xp",0)-state.startXP, L=levelFromXP(store.get("xp",0));
  $("#xp-gain").textContent=`+${gained.toLocaleString()} XP  ·  Lv ${L.level} ${rankFor(L.level)}`;
  $("#ach-earned").innerHTML=state.newAch.map(a=>`<span class="chip">${a.icon} ${a.name}</span>`).join("");
  $("#name-input").value = store.get("name","");
  refreshAllAds(); show("result"); showBoxButton();
  const wq=(state.mode==="daily"||state.mode==="challenge")?(right/Math.max(1,total)):Math.min(1,state.score/3500);
  showEarnedCard(grantCollectible(wq));

  // percentile + leaderboard (server-verified if backend on; estimate otherwise)
  submitScore(fixed?right:state.score, fixed?total:null).catch(()=>{});
}

async function submitScore(score,total){
  const mode=state.mode, pe=$("#percentile");
  if(api.on()){
    pe.textContent="Ranking you…";
    try{ const d=await api.post("/api/score",{mode, name:store.get("name","")||"Anonymous", day:todayKey(), score, guesses:state.guesses});
      if(d&&d.percentile!=null) pe.textContent=`You beat ${d.percentile}% of players${mode==="daily"?" today":""}.`;
      else if(d&&d.rank) pe.textContent=`Global rank #${d.rank}.`;
      else pe.textContent="";
      renderLeaderboard();
    }catch{ pe.textContent=`Top ~${100-estPercentile(mode,score,total)}% (est.)`; }
  } else {
    const p=estPercentile(mode,score,total);
    pe.textContent=`Better than ~${p}% of players (est.) · connect the backend for live ranks`;
  }
}

/* ---------- share + challenge ---------- */
function esc(s){ return String(s).replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])); }
function buildShareText(){
  const right=state.results.filter(r=>r==="win").length,total=state.results.length;
  if(state.mode==="daily") return `${BRAND} ${todayKey()} — ${right}/${total}\n${state.results.map(r=>r==="win"?"🟩":r==="skip"?"🟨":"🟥").join("")}\nCan you spot the AI? ${SHARE_URL}`;
  if(state.mode==="challenge") return `I got ${right}/${total} on a ${BRAND} challenge. ${SHARE_URL}`;
  if(state.mode==="blitz") return `⚡ I scored ${state.score.toLocaleString()} in 60s on ${BRAND} Blitz. Beat me? ${SHARE_URL}`;
  return `I scored ${state.score.toLocaleString()} (🔥${store.get("bestStreak",0)} best streak) on ${BRAND}. ${SHARE_URL}`;
}
async function share(){ const text=buildShareText();
  try{ if(navigator.share){ await navigator.share({text}); return; } }catch{}
  try{ await navigator.clipboard.writeText(text); toastShare("Copied! Paste it anywhere."); }catch{ toastShare(text); } }
function toastShare(m){ const t=$("#share-toast"); t.textContent=m; setTimeout(()=>{ if(t.textContent===m) t.textContent=""; },2600); }

async function challengeFriend(){
  const name=($("#name-input").value||"").trim().slice(0,24); if(name) store.set("name",name);
  const fixed=state.mode==="daily"||state.mode==="challenge";
  const seed = fixed ? state.seed : Math.floor(Math.random()*1e9);
  const score = fixed ? state.results.filter(r=>r==="win").length : null;
  const base=location.origin+location.pathname;
  let link;
  if(api.on()){ try{ const d=await api.post("/api/challenge",{seed,name:name||"A challenger",score}); link=`${base}?ch=${d.id}`; }catch{} }
  if(!link){ link=`${base}?c=${seed}${score!=null?`&s=${score}`:""}&n=${encodeURIComponent(name||"A challenger")}`; }
  try{ if(navigator.share){ await navigator.share({text:`${name||"I"} challenge you on ${BRAND} — spot the AI!`, url:link}); return; } }catch{}
  try{ await navigator.clipboard.writeText(link); toastShare("Challenge link copied — send it!"); }catch{ toastShare(link); }
}

/* ---------- mode switch ---------- */
function setMode(mode){ clearInterval(blitzTimer); selectedMode=mode; pendingChallenge=null;
  document.querySelectorAll(".mode-btn").forEach(b=>b.classList.toggle("is-active",b.dataset.mode===mode));
  show("start"); renderStart(); }

/* ===================== SEASON 1: coins · daily reward · mystery box · leagues · shop ===================== */
const COIN_PER_CORRECT=5;
const DIVISIONS=["Bronze","Silver","Gold","Sapphire","Ruby","Diamond"];
const OPP_NAMES=["Mia","Liam","Zoe","Noah","Ava","Kai","Ivy","Leo","Rae","Max","Nina","Omar","Eli","Tara","Jude","Cleo","Anya","Sam","Remy","Wren"];
const THEMES={ default:{acc:"#7c5cff",acc2:"#39d0ff"}, neon:{acc:"#00e5a0",acc2:"#ff3df0"}, sunset:{acc:"#ff7a3d",acc2:"#ffd54a"} };

function coins(){ return store.get("coins",0); }
function addCoins(n){ store.set("coins",coins()+n); updateCoins(); }
function spendCoins(n){ if(coins()<n) return false; store.set("coins",coins()-n); updateCoins(); return true; }
function updateCoins(){ const a=$("#coin-n"),b=$("#shop-coins"); if(a)a.textContent=coins().toLocaleString(); if(b)b.textContent=coins().toLocaleString(); }
function yesterdayKey(){ const d=new Date(); d.setDate(d.getDate()-1); return dateKey(d); }
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0; return h>>>0; }

/* daily reward (escalates over a 7-day cycle) */
function checkDailyReward(){
  const t=todayKey(); if(store.get("drClaim","")===t) return;
  const dr=store.get("dr",{streak:0,last:""});
  const streak=(dr.last===yesterdayKey())?dr.streak+1:1, day=((streak-1)%7)+1;
  pendingDaily={amt:[50,60,75,90,110,140,250][day-1], streak};
  $("#daily-reward-line").textContent=`Day ${day} of 7 — welcome back!`;
  $("#daily-reward-amt").textContent=`+${pendingDaily.amt} 🪙`;
  $("#daily-overlay").classList.remove("hidden");
}
function claimDaily(){ if(pendingDaily){ const t=todayKey(); addCoins(pendingDaily.amt); store.set("drClaim",t); store.set("dr",{streak:pendingDaily.streak,last:t}); pendingDaily=null; } $("#daily-overlay").classList.add("hidden"); }

/* mystery box — variable-ratio reward, one per finished run */
function showBoxButton(){ boxReady=true; const b=$("#btn-box"); b.classList.remove("hidden"); b.disabled=false; b.textContent="🎁 Open Mystery Box"; }
function openBox(){
  if(!boxReady) return; boxReady=false; const r=Math.random(); let label;
  if(r<0.55){ const c=10+Math.floor(Math.random()*50); addCoins(c); label=`+${c} 🪙`; }
  else if(r<0.82){ const c=60+Math.floor(Math.random()*90); addCoins(c); label=`Nice! +${c} 🪙`; }
  else if(r<0.95){ store.set("hintBank",store.get("hintBank",0)+3); label="🔍 +3 Hints!"; }
  else { addCoins(300); label="💎 JACKPOT +300 🪙"; confetti(); }
  snd(r>=0.95?"level":"ach"); const b=$("#btn-box"); b.textContent=`🎁 ${label}`; b.disabled=true;
}

/* leagues — weekly division ladder with promotion / relegation (local sim; ready for Worker) */
function curWeek(){ const d=new Date(); const o=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); o.setUTCDate(o.getUTCDate()-((o.getUTCDay()+6)%7)); return o.toISOString().slice(0,10); }
function weekProgress(){ const start=new Date(curWeek()+"T00:00:00Z").getTime(); return Math.max(0.03,Math.min(1,(Date.now()-start)/(7*864e5))); }
function leagueGet(){ let L=store.get("league",null); if(!L){ L={div:0,week:curWeek(),lp:0}; store.set("league",L);} return L; }
function addLP(n){ const L=leagueGet(); leagueRollover(L); L.lp+=n; store.set("league",L); }
function leagueOpponents(week,div,progress){
  const rng=mulberry32(hashStr(week+"|"+div)); const base=150+div*220;
  return shuffle(OPP_NAMES,rng).slice(0,14).map(nm=>({name:nm, lp:Math.round(base*(0.5+rng()*1.6)*progress*(0.8+rng()*0.4))}));
}
function leagueRollover(L){
  if(L.week===curWeek()) return;
  const rows=[...leagueOpponents(L.week,L.div,1),{name:"You",lp:L.lp,me:true}].sort((a,b)=>b.lp-a.lp);
  const rank=rows.findIndex(x=>x.me)+1;
  const reward=rank===1?500:rank===2?300:rank===3?200:rank<=5?100:rank<=10?25:0;
  if(reward) addCoins(reward);
  let div=L.div; if(rank<=5) div=Math.min(DIVISIONS.length-1,div+1); else if(rank>=11) div=Math.max(0,div-1);
  toast(`🏆 Last week: #${rank} ${DIVISIONS[L.div]}${reward?` · +${reward}🪙`:""}${div>L.div?" · promoted!":div<L.div?" · relegated":""}`);
  L.div=div; L.week=curWeek(); L.lp=0; store.set("league",L);
}
function openLeague(){
  const L=leagueGet(); leagueRollover(L); const p=weekProgress();
  const rows=[...leagueOpponents(L.week,L.div,p),{name:"You",lp:L.lp,me:true}].sort((a,b)=>b.lp-a.lp);
  $("#league-name").textContent=DIVISIONS[L.div]+" League";
  const dleft=Math.max(0,Math.ceil((new Date(curWeek()+"T00:00:00Z").getTime()+7*864e5-Date.now())/864e5));
  $("#league-sub").innerHTML=`Top 5 promote · bottom 5 drop · <b>${dleft}d</b> left`;
  $("#league-list").innerHTML=rows.map((r,i)=>`<div class="lg-row ${r.me?"me":""} ${i<5?"promote":i>=rows.length-5?"relegate":""}"><span>${i+1}. ${esc(r.name)}</span><b>${r.lp} LP</b></div>`).join("");
  $("#league-overlay").classList.remove("hidden");
}

/* shop + themes */
const SHOP=[
  {id:"freeze",icon:"🧊",name:"Streak Freeze",desc:"Protect your daily streak for one missed day",cost:200},
  {id:"revive",icon:"❤️",name:"Revive Token",desc:"One free revive — no ad",cost:250},
  {id:"hint10",icon:"🔍",name:"Hint Pack",desc:"+10 hints across future runs",cost:150},
  {id:"neon",icon:"🎨",name:"Neon Theme",desc:"Unlock the Neon colour theme",cost:500},
  {id:"sunset",icon:"🌅",name:"Sunset Theme",desc:"Unlock the Sunset colour theme",cost:500},
  {id:"drop",icon:"🎴",name:"Mystery Card Drop",desc:"A random collectible for your Vault",cost:120},
];
function owned(){ return store.get("owned",{}); }
function openShop(){
  updateCoins(); const own=owned(), theme=store.get("theme","default");
  $("#shop-list").innerHTML=SHOP.map(it=>{
    let right;
    if(it.id==="neon"||it.id==="sunset") right = own[it.id] ? (theme===it.id?`<span class="owned">Equipped</span>`:`<button class="buy" data-equip="${it.id}">Equip</button>`) : `<button class="buy" data-buy="${it.id}">🪙 ${it.cost}</button>`;
    else right=`<button class="buy" data-buy="${it.id}">🪙 ${it.cost}</button>`;
    return `<div class="shop-row"><span class="shop-i">${it.icon}</span><span class="shop-t"><b>${it.name}</b><small>${it.desc}</small></span>${right}</div>`;
  }).join("");
  $("#shop-overlay").classList.remove("hidden");
}
function buyItem(id){
  const it=SHOP.find(x=>x.id===id); if(!it) return;
  if(!spendCoins(it.cost)){ toast("Not enough 🪙 — play a round to earn more!"); return; }
  if(id==="freeze") store.set("freeze",true);
  else if(id==="revive") store.set("reviveTokens",store.get("reviveTokens",0)+1);
  else if(id==="hint10") store.set("hintBank",store.get("hintBank",0)+10);
  else if(id==="drop"){ const ais=ROUNDS.filter(x=>x.isAI), v=vaultGet(), fresh=ais.filter(x=>!v[x.id]), arr=fresh.length?fresh:ais, pick=arr[Math.floor(Math.random()*arr.length)], key=rarityFor(pick,0.3); if(v[pick.id]) addCoins(40); else { v[pick.id]={rar:key,src:pick.src,fool:foolRate(pick),ts:Date.now()}; store.set("vault",v); } toast(`🎴 ${RARITY[key].name} card added to your Vault!`); }
  else { const own=owned(); own[id]=true; store.set("owned",own); store.set("theme",id); applyTheme(); }
  snd("ach"); toast(`${it.icon} ${it.name} purchased!`); openShop();
}
function applyTheme(){ const t=THEMES[store.get("theme","default")]||THEMES.default; document.documentElement.style.setProperty("--acc",t.acc); document.documentElement.style.setProperty("--acc2",t.acc2); }

/* ===================== THE VAULT: collectible AI-image cards ===================== */
const RARITY={ common:{name:"Common",color:"#9aa3b2",rank:0}, rare:{name:"Rare",color:"#39d0ff",rank:1}, epic:{name:"Epic",color:"#b45cff",rank:2}, legendary:{name:"Legendary",color:"#ffd54a",rank:3} };
function rarityFor(r, winQuality){ const roll=foolRate(r)+Math.round((winQuality||0)*18)+(Math.floor(Math.random()*12)-4);
  return roll>=92?"legendary":roll>=76?"epic":roll>=58?"rare":"common"; }
function vaultGet(){ return store.get("vault",{}); }
// gift the player the AI image they're proudest of catching this run; rarity scales with how
// many it fooled + how well they did. (AI images only — the real stock photos are never gifted.)
function grantCollectible(winQuality){
  const caught=state.deck.slice(0,state.i).filter((r,i)=>r&&r.isAI&&state.results[i]==="win");
  const pool=caught.length?caught:state.deck.slice(0,state.i).filter(r=>r&&r.isAI);
  if(!pool.length) return null;
  const r=pool.slice().sort((a,b)=>foolRate(b)-foolRate(a))[0], v=vaultGet(), key=rarityFor(r,winQuality);
  if(v[r.id]){ const bonus={common:15,rare:30,epic:60,legendary:120}[key]; addCoins(bonus); return {dupe:true,key,bonus}; }
  v[r.id]={rar:key,src:r.src,fool:foolRate(r),ts:Date.now()}; store.set("vault",v); return {dupe:false,key,src:r.src};
}
function showEarnedCard(res){ const el=$("#card-earned"); if(!res){ el.classList.add("hidden"); return; }
  const R=RARITY[res.key];
  if(res.dupe) el.innerHTML=`<div class="ce-txt">🎴 Duplicate ${R.name} card — converted to <b>+${res.bonus} 🪙</b></div>`, el.className="card-earned dupe";
  else { el.className="card-earned r-"+res.key; el.innerHTML=`<img src="${res.src}" alt=""><div class="ce-txt">🎴 You captured a <b style="color:${R.color}">${R.name}</b> card!<br><span style="color:var(--mut);font-weight:600">Saved to your Vault — tap 🎴 to view & download.</span></div>`; if(res.key==="epic"||res.key==="legendary"){ confetti(); snd("level"); } }
  el.classList.remove("hidden");
}
function openVault(){
  const v=vaultGet(), entries=Object.entries(v).sort((a,b)=>(RARITY[b[1].rar].rank-RARITY[a[1].rar].rank)||(b[1].ts-a[1].ts));
  const total=ROUNDS.filter(x=>x.isAI).length;
  $("#vault-sub").textContent = entries.length?`${entries.length} / ${total} AI images captured`:"";
  $("#vault-grid").innerHTML = entries.length
    ? entries.map(([id,c])=>`<div class="vcard r-${c.rar}"><img src="${c.src}" loading="lazy" alt=""><button class="vdl" data-dl="${c.src}" title="Download wallpaper">⬇</button></div>`).join("")
    : `<div class="lb-load" style="grid-column:1/-1">Win rounds to capture cards — the AI you catch joins your Vault, rarer the more people it fooled.</div>`;
  $("#vault-overlay").classList.remove("hidden");
}
function downloadCard(src){ try{ const a=document.createElement("a"); a.href=src; a.download="aimposter_"+(src.split("/").pop()||"card.jpg"); document.body.appendChild(a); a.click(); a.remove(); toast("⬇ Saved — set it as your wallpaper!"); }catch{} }

/* ---------- bind ---------- */
function bind(){
  $("#btn-play").addEventListener("click",()=>startRun(pendingChallenge?"challenge":selectedMode));
  $("#btn-next").addEventListener("click",next);
  $("#btn-again").addEventListener("click",()=>{ clearInterval(blitzTimer); pendingChallenge=null; show("start"); renderStart(); });
  $("#btn-share").addEventListener("click",share);
  $("#btn-challenge").addEventListener("click",challengeFriend);
  $("#brand-home").addEventListener("click",()=>{ clearInterval(blitzTimer); pendingChallenge=null; show("start"); renderStart(); });
  $("#pu-hint").addEventListener("click",useHint); $("#pu-skip").addEventListener("click",useSkip);
  $("#btn-revive").addEventListener("click",doRevive);
  $("#btn-endrun").addEventListener("click",()=>{ $("#revive-overlay").classList.add("hidden"); endRun(); });
  document.querySelectorAll(".mode-btn").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
  document.querySelectorAll(".choice").forEach(b=>b.addEventListener("click",()=>guess(b.dataset.guess)));
  $("#how-link").addEventListener("click",()=>$("#how-box").classList.toggle("hidden"));
  $("#sound-toggle").addEventListener("click",()=>{ const on=!store.get("soundOn",true); store.set("soundOn",on); $("#sound-toggle").textContent=on?"🔊":"🔇"; if(on) snd("tick"); });
  // Season 1
  $("#league-btn").addEventListener("click",openLeague);
  $("#shop-btn").addEventListener("click",openShop);
  $("#coins-pill").addEventListener("click",openShop);
  $("#btn-claim-daily").addEventListener("click",claimDaily);
  $("#btn-box").addEventListener("click",openBox);
  $("#btn-revive-token").addEventListener("click",doReviveToken);
  $("#btn-close-league").addEventListener("click",()=>$("#league-overlay").classList.add("hidden"));
  $("#btn-close-shop").addEventListener("click",()=>$("#shop-overlay").classList.add("hidden"));
  $("#vault-btn").addEventListener("click",openVault);
  $("#btn-close-vault").addEventListener("click",()=>$("#vault-overlay").classList.add("hidden"));
  $("#vault-grid").addEventListener("click",e=>{ const b=e.target.closest("button[data-dl]"); if(b) downloadCard(b.dataset.dl); });
  $("#shop-list").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
    if(b.dataset.buy) buyItem(b.dataset.buy);
    else if(b.dataset.equip){ store.set("theme",b.dataset.equip); applyTheme(); openShop(); } });
}

/* ---------- parse challenge link ---------- */
async function parseChallenge(){
  const p=new URLSearchParams(location.search);
  if(p.get("ch") && api.on()){ try{ const d=await api.get(`/api/challenge?id=${encodeURIComponent(p.get("ch"))}`); if(d&&d.seed!=null){ pendingChallenge={seed:+d.seed,score:d.score??null,name:d.name||"A challenger"}; selectedMode="challenge"; } }catch{} }
  else if(p.get("c")){ pendingChallenge={seed:+p.get("c"), score:p.get("s")!=null&&p.get("s")!==""?+p.get("s"):null, name:p.get("n")?decodeURIComponent(p.get("n")):"A challenger"}; selectedMode="challenge"; }
}

/* ---------- boot ---------- */
async function boot(){
  bind(); $("#sound-toggle").textContent=store.get("soundOn",true)?"🔊":"🔇";
  document.querySelectorAll(".mode-btn").forEach(b=>b.classList.toggle("is-active",b.dataset.mode==="daily"));
  seen=store.get("seen",{}); seenCtr=store.get("seenCtr",0);
  applyTheme(); updateCoins(); leagueRollover(leagueGet());
  try{ ROUNDS=await (await fetch("content/rounds.json",{cache:"no-store"})).json(); }catch(e){ console.error("content load failed",e); }
  if(!ROUNDS.length){ $("#btn-play").disabled=true; $("#daily-note").textContent="No content. Run build_content.py."; return; }
  await parseChallenge();
  renderStart();
  checkDailyReward();
}
boot();
