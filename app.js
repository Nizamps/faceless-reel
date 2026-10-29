const $ = (id) => document.getElementById(id);
const fields = ['series-name','niche','language','voice','art','caption','music','effects','aspect','duration','schedule'];
const defaults = { 'series-name':'History in 60 Seconds', niche:'History', language:'English', voice:'Warm documentary', art:'Cinematic archival illustration', caption:'Bold, clean subtitles', music:'Subtle cinematic', effects:'Slow camera moves + soft transitions', aspect:'9:16', duration:'50', schedule:'daily' };
const AUTH_REDIRECT_URL = 'https://nizamps.github.io/faceless-reel/';
const config = window.FACELESS_SUPABASE;
let client = null;
let user = null;
let episodes = [];
let toastTimer;

function notify(message) { const toast=$('toast'); toast.textContent=message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.classList.remove('show'),3200); }
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function settings() { return Object.fromEntries(fields.map(id=>[id,$(id).value])); }
function cloudSettings(s=settings()) {
  return { user_id:user.id, series_name:s['series-name'], niche:s.niche, language:s.language, voice_style:s.voice, art_style:s.art, caption_style:s.caption, music_style:s.music, effects_style:s.effects, aspect_ratio:s.aspect, duration_seconds:Number(s.duration), daily_enabled:s.schedule==='daily', timezone:'Asia/Kolkata', ready_by:'19:00:00', monthly_budget_usd:30 };
}
function settingsFromCloud(row) {
  return { 'series-name':row.series_name, niche:row.niche, language:row.language, voice:row.voice_style, art:row.art_style, caption:row.caption_style, music:row.music_style, effects:row.effects_style, aspect:row.aspect_ratio, duration:String(row.duration_seconds), schedule:row.daily_enabled?'daily':'off' };
}
function saveLocalSettings(silent=false) {
  const s=settings(); localStorage.setItem('faceless-settings',JSON.stringify(s)); $('series-stat').textContent=s['series-name'];
  if(user) saveCloudSettings(s).catch(error=>notify(`Cloud save failed: ${error.message}`));
  if(!silent) notify(user?'Series settings saved to your studio.':'Saved on this device. Sign in to save and schedule in Supabase.');
}
async function saveCloudSettings(s=settings()) {
  const {error}=await client.from('series_settings').upsert(cloudSettings(s),{onConflict:'user_id'});
  if(error) throw error;
  $('series-stat').textContent=s['series-name'];
}
function setSettings(s) {
  for(const id of fields) if(s[id]!==undefined && $(id)) $(id).value=String(s[id]);
  if(!Array.from($('duration').options).some(option=>option.value===$('duration').value)) $('duration').value='50';
  $('series-stat').textContent=$('series-name').value;
}
function renderEpisodes() {
  $('episode-count').textContent=episodes.length;
  const finished=episodes.filter(ep=>ep.status==='ready').length;
  $('draft-stat').textContent=`${episodes.length} ${episodes.length===1?'episode':'episodes'} · ${finished} ready`;
  if(!episodes.length){ $('episodes-list').innerHTML='<div class="empty-state"><span class="empty-icon">▤</span><div><b>Your daily video library will appear here.</b><p>Enable daily preparation in your series settings after signing in.</p></div></div>'; return; }
  $('episodes-list').innerHTML=episodes.slice(0,12).map((ep,i)=>`<div class="episode-row"><div class="episode-thumb">${ep.status==='ready'?'▶':String(i+1).padStart(2,'0')}</div><div class="episode-info"><b>${escapeHtml(ep.title||ep.topic||'Daily history video')}</b><small>${escapeHtml(ep.topic||'AI-selected history topic')} · ${new Date(ep.created_at||ep.createdAt||Date.now()).toLocaleDateString()}</small></div><span class="draft-badge ${ep.status==='ready'?'ready-badge':''}">${escapeHtml((ep.status||'draft').replace('_',' ').toUpperCase())}</span>${ep.status==='ready'?`<button class="mini-button primary" data-download="${i}">↓ MP4</button>`:`<button class="mini-button" data-open="${i}">Details</button>`}</div>`).join('');
  document.querySelectorAll('[data-open]').forEach(btn=>btn.addEventListener('click',()=>showEpisode(episodes[Number(btn.dataset.open)])));
  document.querySelectorAll('[data-download]').forEach(btn=>btn.addEventListener('click',()=>downloadVideo(episodes[Number(btn.dataset.download)])));
}
async function downloadVideo(ep) {
  if(!ep.storage_path) return notify('The MP4 is not available yet.');
  const {data,error}=await client.storage.from('daily-videos').createSignedUrl(ep.storage_path,3600);
  if(error) return notify(`Could not make download link: ${error.message}`);
  const a=document.createElement('a'); a.href=data.signedUrl; a.download=`${slug(ep.title||'daily-video')}.mp4`; a.rel='noopener'; a.click();
}
function packageMarkdown(ep) {
  const s=settings(); return `# ${ep.title}\n\n**Series:** ${$('series-name').value}  \n**Topic:** ${ep.topic}  \n**Target length:** ${s.duration} seconds  \n**Aspect ratio:** ${s.aspect}\n\n## Hook\n${ep.hook}\n\n## Narration\n${ep.narration}\n\n## Scene plan\n${(ep.scenes||[]).map(scene=>`### ${scene.time}\n**Visual:** ${scene.visual||scene.visual_prompt}\n\n**Caption:** ${scene.caption}`).join('\n\n')}\n\n## YouTube description\n${ep.description}\n\n## Tags\n${(ep.tags||[]).join(', ')}\n\n## Thumbnail prompt\n${ep.thumbnailPrompt||ep.thumbnail_prompt}\n\n---\nGenerated with Faceless Studio. Verify facts and review the finished video before publishing.\n`;
}
function showEpisode(ep) {
  // Daily-worker episodes keep their complete production package in `script`.
  if (ep.script && typeof ep.script === 'object') ep = { ...ep, ...ep.script, topic:ep.topic || ep.script.topic, title:ep.title || ep.script.title };
  $('result').hidden=false;
  $('result').innerHTML=`<h3>${escapeHtml(ep.title||'Episode draft')}</h3><p><b>Opening hook</b><br>${escapeHtml(ep.hook||'')}</p><p><b>Narration draft</b><br>${escapeHtml(ep.narration||'')}</p><div class="result-actions"><button class="mini-button primary" id="download-package">↓ Download episode package</button><button class="mini-button" id="download-json">Export JSON</button></div><div class="scene-list">${(ep.scenes||[]).map(scene=>`<div class="scene"><div class="scene-head"><b>${escapeHtml(scene.time)}</b><span>SCENE</span></div><p><b>Visual:</b> ${escapeHtml(scene.visual||scene.visual_prompt)}<br><b>Caption:</b> ${escapeHtml(scene.caption)}</p></div>`).join('')}</div><p><b>YouTube description</b><br>${escapeHtml(ep.description||'')}</p><p><b>Thumbnail direction</b><br>${escapeHtml(ep.thumbnailPrompt||ep.thumbnail_prompt||'')}</p>`;
  $('download-package').addEventListener('click',()=>download(`${slug(ep.title||'episode')}.md`,packageMarkdown(ep),'text/markdown'));
  $('download-json').addEventListener('click',()=>download(`${slug(ep.title||'episode')}.json`,JSON.stringify(ep,null,2),'application/json'));
  $('episodes').scrollIntoView({behavior:'smooth',block:'start'});
}
function slug(text){return String(text).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'episode';}
function download(name,data,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

async function loadEpisodes() {
  if(!user) { episodes=[];renderEpisodes();return; }
  const {data,error}=await client.from('episodes').select('*').order('created_at',{ascending:false}).limit(12);
  if(error) { notify(`Could not load your library: ${error.message}`);return; }
  episodes=data||[];renderEpisodes();$('library-note').textContent='Private Supabase library · MP4 links expire after one hour';
}
async function onAuthChanged(session) {
  user=session?.user||null;
  const authButton=$('auth-button'); const strip=$('auth-strip'); const pill=$('connection-pill');
  if(user) {
    authButton.textContent='Sign out'; authButton.dataset.signedIn='true'; pill.classList.add('ready');$('connection-label').textContent='Supabase synced';
    $('auth-form').hidden=true;$('auth-user').hidden=false;$('auth-user').textContent=`Signed in as ${user.email}`;strip.classList.add('signed-in');
    const {data,error}=await client.from('series_settings').select('*').maybeSingle();
    if(error) notify(`Could not load settings: ${error.message}`);
    if(data) {setSettings(settingsFromCloud(data));localStorage.setItem('faceless-settings',JSON.stringify(settings()));}
    else await saveCloudSettings();
    await loadEpisodes();
  } else {
    authButton.textContent='Sign in to sync';delete authButton.dataset.signedIn; pill.classList.remove('ready');$('connection-label').textContent='Sign in for daily videos';
    $('auth-form').hidden=false;$('auth-user').hidden=true;strip.classList.remove('signed-in');$('library-note').textContent='Sign in to load cloud drafts and finished videos';
    const saved=JSON.parse(localStorage.getItem('faceless-settings')||'null')||defaults;setSettings(saved);episodes=[];renderEpisodes();
  }
}
async function sendSignIn(e) {
  e.preventDefault(); if(!client) return notify('Supabase is not configured yet.');
  const button=$('auth-submit');button.disabled=true;button.textContent='Sending…';
  const {error}=await client.auth.signInWithOtp({email:$('auth-email').value.trim(),options:{emailRedirectTo:AUTH_REDIRECT_URL}});
  button.disabled=false;button.textContent='Email me a sign-in link';
  if(error) notify(error.message); else notify('Check your email for a secure sign-in link.');
}
async function generate() {
  const topic=$('topic').value.trim(); if(!topic){$('topic').focus();notify('Add a topic to get started.');return;}
  if(!user) return notify('Sign in first so Gemini can save the episode to your private library.');
  const button=$('generate');button.disabled=true;button.innerHTML='<span>✦</span> Building your episode…';
  try {
    const {data,error}=await client.functions.invoke('generate-episode',{body:{topic,settings:settings()}});
    if(error) throw error;
    const ep=data.episode; episodes.unshift(ep);renderEpisodes();showEpisode(ep);notify('Your episode package is ready.');
  } catch(error){notify(error.message||'Could not generate episode. Check the Supabase function setup.');}
  finally{button.disabled=false;button.innerHTML='<span>✦</span> Generate episode package <span class="button-arrow">→</span>';}
}

const saved=JSON.parse(localStorage.getItem('faceless-settings')||'null')||defaults;setSettings(saved);
$('save-settings').addEventListener('click',()=>saveLocalSettings());
fields.forEach(id=>$(id).addEventListener('change',()=>saveLocalSettings(true)));
$('generate').addEventListener('click',generate);
$('topic').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey))generate();});
$('auth-form').addEventListener('submit',sendSignIn);
$('auth-button').addEventListener('click',async()=>{if(user){await client.auth.signOut();}else{$('auth-email').focus();$('auth-strip').scrollIntoView({behavior:'smooth',block:'start'});}});
$('series-name').addEventListener('input',()=>{$('series-stat').textContent=$('series-name').value;});

if(config?.url&&config?.publishableKey&&window.supabase?.createClient) {
  client=window.supabase.createClient(config.url,config.publishableKey);
  client.auth.onAuthStateChange((_event,session)=>{queueMicrotask(()=>onAuthChanged(session));});
  client.auth.getSession().then(({data})=>onAuthChanged(data.session));
} else {
  $('connection-label').textContent='Supabase setup required';$('auth-form').hidden=true;
  $('auth-strip').querySelector('small').textContent='The cloud project configuration is missing. See README for setup.';
}
