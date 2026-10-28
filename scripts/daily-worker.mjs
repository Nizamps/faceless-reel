import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
if (!supabaseUrl || !serviceKey || !geminiKey) throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and a new GEMINI_API_KEY in the workflow secrets.');

const BUCKET = 'daily-videos';
const EPISODE_ESTIMATE = 0.95;
const TZ = 'Asia/Kolkata';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function supabase(table, { method='GET', query='', body, prefer } = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${method} ${table} failed (${response.status}): ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : null;
}

function localDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}

async function updateEpisode(id, patch) {
  return supabase('episodes', { method:'PATCH', query:`id=eq.${encodeURIComponent(id)}`, body:{ ...patch, updated_at:new Date().toISOString() }, prefer:'return=minimal' });
}

function collectModelText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  return (data.steps || []).filter(step => step.type === 'model_output')
    .flatMap(step => step.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
}

function collectPart(data, type) {
  const shortcut = type === 'image' ? data.output_image : data.output_audio;
  if (shortcut?.data) return { data:shortcut.data, mime_type:shortcut.mime_type || (type==='image'?'image/jpeg':'audio/mpeg') };
  for (const step of data.steps || []) for (const part of step.content || []) {
    if (part.type === type && part.data) return { data:part.data, mime_type:part.mime_type || (type==='image'?'image/jpeg':'audio/mpeg') };
  }
  return null;
}

async function interaction({ model, input, tools, response_format, generation_config }) {
  const response = await fetch(`${BASE}/interactions`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-goog-api-key':geminiKey },
    body:JSON.stringify({ model, input, ...(tools?{tools}:{}), ...(response_format?{response_format}:{}), ...(generation_config?{generation_config}:{}), store:false }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Gemini ${model} request failed (${response.status}).`);
  return result;
}

function parseJsonText(value) {
  const clean=value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const start=clean.indexOf('{'), end=clean.lastIndexOf('}');
  if(start<0||end<=start) throw new Error('Gemini did not return the expected episode JSON.');
  return JSON.parse(clean.slice(start,end+1));
}

async function createScript(settings, previousTopics) {
  const prompt = `Create today's next short-form faceless ${settings.niche} episode. Choose a specific, surprising, historically supportable topic that is not in this recent-topic list: ${JSON.stringify(previousTopics)}. Research using Google Search before writing. Return only valid JSON with fields title, topic, hook, narration, scenes, description, tags, thumbnailPrompt, sources. Make the narration ${settings.duration_seconds} seconds long (about 105-125 words for 50 seconds); use ${settings.language}; delivery style: ${settings.voice_style}. Include exactly 6 scene objects with time (start-end as M:SS-M:SS), visual (a specific ${settings.art_style} image composition for ${settings.aspect_ratio}), and caption (short readable text safe inside the frame). End narration with a satisfying close. Use no invented quotes. Keep visuals and captions suitable for ${settings.aspect_ratio}. Include sources as an array of {title,url}. Music mood: ${settings.music_style}.`;
  const data=await interaction({model:'gemini-3.8-flash',input:prompt,tools:[{type:'google_search'}]});
  const script=parseJsonText(collectModelText(data));
  if(!script.title||!script.narration||!Array.isArray(script.scenes)||script.scenes.length<4) throw new Error('Gemini returned an incomplete episode plan.');
  return script;
}

async function createImage(prompt, settings) {
  const data=await interaction({
    model:'gemini-nano-banana-2.1',
    input:`Create a single clean story frame, no readable text or lettering. Art direction: ${settings.art_style}. Compose for ${settings.aspect_ratio} with important objects in the center-safe area and leave clean lower space for captions. Scene: ${prompt}`,
    response_format:{type:'image',mime_type:'image/jpeg',aspect_ratio:settings.aspect_ratio,image_size:'4K'},
  });
  const image=collectPart(data,'image');
  if(!image) throw new Error('Gemini did not return a scene image.');
  return Buffer.from(image.data,'base64');
}

function voiceName(style) {
  const s=String(style).toLowerCase();
  if(s.includes('curious')) return 'Puck';
  if(s.includes('dramatic')) return 'Charon';
  if(s.includes('calm')) return 'Aoede';
  return 'Kore';
}

async function createVoice(script, settings) {
  const data=await interaction({
    model:'gemini-3.8-flash-tts',
    input:[{type:'user_input',content:[{type:'text',text:script.narration,annotations:[{type:'speech_metadata',style:`${settings.voice_style}, clear documentary narration, measured pacing`}]}]}],
    response_format:{type:'audio'},
    generation_config:{speech_config:[{voice:voiceName(settings.voice_style)}]},
  });
  const audio=collectPart(data,'audio');
  if(!audio) throw new Error('Gemini did not return narration audio.');
  return { data:Buffer.from(audio.data,'base64'), mime:audio.mime_type };
}

async function createMusic(settings) {
  const data=await interaction({model:'lyria-3.5',input:`Create an instrumental background score for a ${settings.duration_seconds}-second ${settings.niche} documentary short. ${settings.music_style}. No vocals, no lyrics, no recognizable melody. Build a subtle beginning, gentle lift in the middle, and clean ending.`});
  const audio=collectPart(data,'audio');
  if(!audio) throw new Error('Lyria did not return a music track.');
  return { data:Buffer.from(audio.data,'base64'), mime:audio.mime_type };
}

function call(command,args,{capture=false}={}) {
  const result=spawnSync(command,args,{encoding:capture?'utf8':'utf8',maxBuffer:30*1024*1024});
  if(result.status!==0) throw new Error(`${command} failed: ${(result.stderr||'').slice(-1200)}`);
  return capture?result.stdout.trim():undefined;
}

function timeToSeconds(value) {
  const match=String(value||'').match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
  if(!match)return null;
  return [Number(match[1])*60+Number(match[2]),Number(match[3])*60+Number(match[4])];
}
function srtTime(seconds) {
  const ms=Math.round(seconds*1000), h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000),r=ms%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(r).padStart(3,'0')}`;
}

function dimensions(aspect) {
  if(aspect==='16:9') return [3840,2160];
  if(aspect==='1:1') return [3840,3840];
  if(aspect==='4:5') return [3072,3840];
  return [2160,3840];
}

async function renderVideo(script, settings, voice, music, dir) {
  const [width,height]=dimensions(settings.aspect_ratio);
  const fps=30;
  const rawScenes=script.scenes.slice(0,8);
  const normalized=[];
  let cursor=0;
  for(let i=0;i<rawScenes.length;i++) {
    const range=timeToSeconds(rawScenes[i].time);
    let start=range?Math.max(cursor,range[0]):cursor;
    let end=range?Math.min(Number(settings.duration_seconds),range[1]):Math.min(Number(settings.duration_seconds),(i+1)*Number(settings.duration_seconds)/rawScenes.length);
    if(end<=start) {start=cursor;end=Math.min(Number(settings.duration_seconds),start+Number(settings.duration_seconds)/rawScenes.length);}
    if(i===rawScenes.length-1) end=Number(settings.duration_seconds);
    normalized.push({...rawScenes[i],start,end});cursor=end;
  }
  if(normalized.length===0) throw new Error('The episode has no scenes to render.');

  const clips=[];
  for(let i=0;i<normalized.length;i++) {
    const scene=normalized[i];
    await updateEpisode(script._episodeId,{status:'artwork',progress:10+Math.round(45*i/normalized.length),progress_message:`Creating scene artwork ${i+1} of ${normalized.length}`});
    const image=await createImage(scene.visual||scene.visual_prompt,settings);
    const imagePath=path.join(dir,`scene-${String(i+1).padStart(2,'0')}.jpg`);
    await writeFile(imagePath,image);
    const clipPath=path.join(dir,`clip-${String(i+1).padStart(2,'0')}.mp4`);
    const seconds=Math.max(1,scene.end-scene.start);
    const zoom=settings.effects_style.includes('camera')?'min(zoom+0.00035,1.07)':'1.0';
    const vf=`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='${zoom}':d=1:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;
    call('ffmpeg',['-y','-loop','1','-framerate',String(fps),'-i',imagePath,'-t',String(seconds),'-vf',vf,'-r',String(fps),'-c:v','libx264','-preset','veryfast','-crf','18','-threads','2','-an','-movflags','+faststart',clipPath]);
    clips.push(clipPath);
  }

  const concatFile=path.join(dir,'clips.txt');
  await writeFile(concatFile,clips.map(file=>`file '${file.replaceAll("'","'\\''")}'`).join('\n'));
  const silent=path.join(dir,'silent.mp4');
  call('ffmpeg',['-y','-f','concat','-safe','0','-i',concatFile,'-c:v','copy','-an',silent]);

  const duration=Number(settings.duration_seconds);
  const subtitles=path.join(dir,'captions.srt');
  const blocks=normalized.map((scene,index)=>`${index+1}\n${srtTime(scene.start)} --> ${srtTime(scene.end)}\n${String(scene.caption||'').replace(/[{}<>]/g,'').replace(/\n/g,' ')}`).join('\n\n');
  await writeFile(subtitles,blocks+'\n');
  const voicePath=path.join(dir,'voice.wav'); await writeFile(voicePath,voice.data);
  const musicPath=path.join(dir,'music.bin'); await writeFile(musicPath,music.data);
  const output=path.join(dir,'daily-video.mp4');
  const subFilter=`subtitles=${subtitles.replaceAll('\\','/').replaceAll(':','\\:')}:force_style='FontName=DejaVu Sans,FontSize=50,PrimaryColour=&H00FFFFFF,OutlineColour=&HAA000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=130'`;
  const visuals=settings.effects_style.toLowerCase().includes('grain')?'noise=alls=2:allf=t+u':settings.effects_style.toLowerCase().includes('vignette')?'vignette=PI/5':'null';
  const finalVf=`${subFilter},${visuals},format=yuv420p`;
  call('ffmpeg',['-y','-i',silent,'-i',voicePath,'-stream_loop','-1','-i',musicPath,'-filter_complex','[1:a]loudnorm=I=-16:LRA=7:TP=-1.5[voice];[2:a]volume=0.16,afade=t=out:st='+Math.max(0,duration-3)+':d=3[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[audio]','-map','0:v:0','-map','[audio]','-vf',finalVf,'-t',String(duration),'-c:v','libx264','-preset','fast','-crf','17','-threads','2','-c:a','aac','-b:a','192k','-movflags','+faststart','-metadata',`title=${script.title}`,'-metadata','comment=AI-generated illustrative short video',output]);
  const probe=call('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=s=x:p=0',output],{capture:true});
  return { output, dimensions:probe };
}

async function uploadVideo(userId,date,title,file) {
  const safeTitle=String(title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'history-short';
  const objectPath=`${userId}/${date}/${safeTitle}.mp4`;
  const bytes=await readFile(file);
  const result=await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`,{
    method:'POST',headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'video/mp4','x-upsert':'true'},body:bytes,
  });
  if(!result.ok) throw new Error(`Supabase Storage upload failed (${result.status}): ${(await result.text()).slice(0,500)}`);
  return objectPath;
}

async function recentTopics(userId) {
  const rows=await supabase('episodes',{query:`select=topic&user_id=eq.${userId}&created_at=gte.${encodeURIComponent(new Date(Date.now()-30*86400000).toISOString())}&order=created_at.desc&limit=40`});
  return (rows||[]).map(row=>row.topic).filter(Boolean);
}

async function runProfile(settings,date) {
  const userId=settings.user_id;
  const existing=await supabase('episodes',{query:`select=id,status&user_id=eq.${userId}&run_type=eq.daily&scheduled_for=eq.${date}&limit=1`});
  if(existing?.length) { console.log(`${userId}: ${date} already has a ${existing[0].status} run; skipping.`);return; }
  const month=date.slice(0,7)+'-01T00:00:00Z';
  const monthRows=await supabase('episodes',{query:`select=estimated_cost_usd&user_id=eq.${userId}&created_at=gte.${encodeURIComponent(month)}&status=neq.budget_hold`});
  const spent=(monthRows||[]).reduce((sum,row)=>sum+Number(row.estimated_cost_usd||0),0);
  const remaining=Number(settings.monthly_budget_usd||30)-spent;
  const shouldHold=remaining<EPISODE_ESTIMATE;
  const created=await supabase('episodes',{method:'POST',query:'select=*',body:{user_id:userId,run_type:'daily',scheduled_for:date,status:shouldHold?'budget_hold':'queued',progress:0,progress_message:shouldHold?'Monthly generation budget reached':'Queued for daily generation',estimated_cost_usd:shouldHold?0:EPISODE_ESTIMATE,duration_seconds:settings.duration_seconds,aspect_ratio:settings.aspect_ratio,resolution:'4k'},prefer:'return=representation'});
  const episode=created[0];
  if(shouldHold){console.log(`${userId}: monthly limit reached; holding daily episode.`);return;}

  const temp=await mkdtemp(path.join(tmpdir(),'faceless-daily-'));
  try {
    const previous=await recentTopics(userId);
    await updateEpisode(episode.id,{status:'researching',progress:4,progress_message:'Choosing and checking today’s history topic'});
    const script=await createScript(settings,previous);script._episodeId=episode.id;
    await updateEpisode(episode.id,{status:'scripting',progress:9,progress_message:'Script and scene plan ready',topic:script.topic||script.title,title:script.title,script,sources:Array.isArray(script.sources)?script.sources:[]});

    await updateEpisode(episode.id,{status:'voiceover',progress:10,progress_message:'Generating narration'});
    const voice=await createVoice(script,settings);
    await updateEpisode(episode.id,{status:'music',progress:14,progress_message:'Composing original instrumental music'});
    const music=await createMusic(settings);

    const render=await renderVideo(script,settings,voice,music,temp);
    const storagePath=await uploadVideo(userId,date,script.title,render.output);
    await updateEpisode(episode.id,{status:'ready',progress:100,progress_message:'4K MP4 ready to download',title:script.title,topic:script.topic||script.title,script,sources:Array.isArray(script.sources)?script.sources:[],storage_path:storagePath,duration_seconds:settings.duration_seconds,aspect_ratio:settings.aspect_ratio,resolution:'4k',finished_at:new Date().toISOString()});
    console.log(`${userId}: ready at ${render.dimensions}, ${storagePath}`);
  } catch(error) {
    console.error(`${userId}: ${error.stack||error}`);
    await updateEpisode(episode.id,{status:'failed',progress_message:'Generation failed; see run details',error_message:String(error.message||error).slice(0,1500)}).catch(console.error);
  } finally {
    await rm(temp,{recursive:true,force:true}).catch(()=>{});
  }
}

async function main() {
  const date=localDate();
  const profiles=await supabase('series_settings',{query:'select=*&daily_enabled=eq.true'});
  console.log(`Daily render date ${date} (${TZ}). Active series: ${profiles.length}.`);
  for(const profile of profiles) {
    try { await runProfile(profile,date); }
    catch(error) { console.error(`Profile ${profile.user_id} failed: ${error.stack||error}`); }
    await sleep(500);
  }
}

await main();
