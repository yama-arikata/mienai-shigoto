// 見えない仕事ページの土台。tsugaru / tsugite / sakan / rousui の動く実装から写したもの。
// スクロール・?p=・?auto=秒・字幕・照明・基本部品はここに置き、Claude には場面と物だけ書かせる。
import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

const S=JSON.parse(document.getElementById('spec').textContent);
const $=id=>document.getElementById(id);
const root=document.documentElement.style;
if(S.accent)root.setProperty('--em',S.accent);
if(S.night)root.setProperty('--night',S.night);
if(S.test)document.body.classList.add('test');
$('tag').textContent=S.tag||'';
$('note').textContent=S.note||'';

const say=m=>{try{if(window.parent!==window)window.parent.postMessage(m,'*');}catch(e){}};
const fail=(msg,o={})=>{const r={kit:'error',message:String(msg),line:o.line||0,col:o.col||0};window.__ERR.push(r);say(r);};

// ===== 場面の時間割（Claude は数字を書かない。順番を変えても動きが崩れない）=====
const CH=S.chapters,N=CH.length,GAP=Math.min(.018,.16/N);
const CHI={};
CH.forEach((c,i)=>{c.a=i/N+(i?GAP:0);c.b=(i+1)/N-(i<N-1?GAP:0);c.first=i===0;c.last=i===N-1;CHI[c.id]=c;});
$('scroll').style.height=Math.round(Math.max(600,N*130))+'vh';

const capsEl=$('caps');
const caps=CH.map(c=>{const s=document.createElement('section');s.className='cap';
 s.innerHTML=`<div class="imgp" hidden><b>イメージ</b><span></span></div><h2>${c.title}</h2><p>${c.body}</p>`;
 if(c.confirm){const d=document.createElement('div');d.className='ask';const b=document.createElement('b');b.textContent='ここは職人に確認';const t=document.createElement('span');t.textContent=c.confirm;d.append(b,t);s.append(d);}
 capsEl.append(s);return{el:s,c};});
const IMG_DEFAULT='見えないものを色や形で表した絵です';
const imgText=c=>c.image_note||IMG_DEFAULT;
function showImgMarks(){for(const x of caps){const on=!!(x.c.image_note||x.c.img),d=x.el.querySelector('.imgp');d.hidden=!on;if(on)d.querySelector('span').textContent=imgText(x.c);}}
const capAlpha=(c,p)=>(c.first?1:ss(c.a-.012,c.a+.008,p))*(c.last?1:1-ss(c.b-.008,c.b+.012,p));

// ===== 描画の準備 =====
const canvas=$('c');
let renderer;
try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});}
catch(e){$('err').style.display='block';say({kit:'error',message:'no_webgl',line:0,col:0});throw e;}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.05;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene();
const nightC=new THREE.Color(S.night||'#0f1216');
scene.background=nightC.clone();
const camera=new THREE.PerspectiveCamera(36,1,.05,160);
scene.environment=new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(),.04).texture;
const phone=(+new URLSearchParams(location.search).get('vw')||innerWidth||screen.width)<760;

// ===== 道具（同じ形が毎回出るように乱数は種つき）=====
let seed=20261105;
const rand=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
const rnd=(a=1,b)=>b===undefined?rand()*a:a+rand()*(b-a);
function ss(a,b,x){const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);}
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=(x,a=0,b=1)=>x<a?a:x>b?b:x;
const seq=(k,p)=>{if(p<=k[0][0])return k[0][1];for(let i=0;i<k.length-1;i++)if(p<=k[i+1][0])return mix(k[i][1],k[i+1][1],ss(k[i][0],k[i+1][0],p));return k[k.length-1][1];};
const V=(x,y,z)=>new THREE.Vector3(x,y,z);
function tex(size,draw,rx=1,ry=1){const c=document.createElement('canvas');c.width=c.height=size;draw(c.getContext('2d'),size);
 const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(rx,ry);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;return t;}
function speckle(g,s,base,cols,n,rmax){g.fillStyle=base;g.fillRect(0,0,s,s);for(let i=0;i<n;i++){g.fillStyle=cols[Math.floor(rnd(cols.length))];g.globalAlpha=rnd(.05,.35);g.beginPath();g.arc(rnd(s),rnd(s),rnd(.4,rmax),0,7);g.fill();}g.globalAlpha=1;}
const bad=(name,what)=>{throw new Error(`K.${name}: ${what}`);};
const vec3=(name,a)=>{if(!Array.isArray(a)||a.length!==3||a.some(v=>!Number.isFinite(v)))bad(name,'位置や向きは [x,y,z] の数字3つで書く');return a;};

// 真っ黒の塊にしない（暗い色も形が読める明るさまで持ち上げる）
function color(c,name='std'){let col;try{col=new THREE.Color(c);}catch(e){bad(name,'色が読めません: '+c);}
 const h={};col.getHSL(h);if(h.l<.022)col.setHSL(h.h,h.s,.022);return col;}

// ===== 材質 =====
function std(o={}){const q={roughness:.62,metalness:0,envMapIntensity:.6,...o};if(o.color!==undefined)q.color=color(o.color);
 if(q.metalness===undefined)q.metalness=0;return new THREE.MeshStandardMaterial(q);}
const metal=(c='#b9bdc1',rough=.34)=>std({color:c,metalness:.85,roughness:rough,envMapIntensity:.9});
const glass=(c='#cfe3ea',opacity=.22)=>{const m=std({color:c,roughness:.08,metalness:.1,transparent:true,opacity:Math.min(.7,opacity),envMapIntensity:1});m.depthWrite=false;return m;};
const emit=(c='#ffc25a',power=1)=>{const m=new THREE.MeshBasicMaterial({color:new THREE.Color(c).multiplyScalar(Math.min(1.6,power)),toneMapped:false});return m;};
const water=(c='#3f7f99')=>{const m=std({color:c,roughness:.06,metalness:.15,transparent:true,opacity:.72,envMapIntensity:1.1});return m;};

// 木：模様そのものを立体で持つ（切り口に年輪が出る）。tsugite から。
const NOISE=`float hh(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float vn(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
 return mix(mix(mix(hh(i),hh(i+vec3(1,0,0)),f.x),mix(hh(i+vec3(0,1,0)),hh(i+vec3(1,1,0)),f.x),f.y),
  mix(mix(hh(i+vec3(0,0,1)),hh(i+vec3(1,0,1)),f.x),mix(hh(i+vec3(0,1,1)),hh(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fb(vec3 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vn(p);p=p*2.03+7.1;a*=.5;}return v;}`;
function wood(o={}){
 const along=o.along||'x',sw={x:'.xyz',y:'.yxz',z:'.zyx'}[along];if(!sw)bad('wood','along は x / y / z');
 const u={uB:{value:color(o.base||'#b98d5c','wood')},uL:{value:color(o.late||'#8b633c','wood')},uSeed:{value:o.seed??rnd(9)},uRC:{value:new THREE.Vector2(rnd(-1.3,1.3),rnd(-.7,.7))},uRF:{value:o.rings||12},uSc:{value:o.scale||1}};
 const m=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.62,metalness:0,envMapIntensity:.7});
 m.onBeforeCompile=sh=>{Object.assign(sh.uniforms,u);
  sh.vertexShader=sh.vertexShader.replace('#include <common>',`#include <common>
   uniform float uSc;varying vec3 vP;varying vec3 vOn;`).replace('#include <begin_vertex>',`#include <begin_vertex>
   vP=position${sw}*uSc;vOn=normal${sw};`);
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
   uniform vec3 uB,uL;uniform float uSeed,uRF;uniform vec2 uRC;varying vec3 vP;varying vec3 vOn;
   ${NOISE}
   float gFib,gLate,gEnd;`).replace('#include <color_fragment>',`#include <color_fragment>
   {vec3 P=vP+vec3(uSeed*3.1,0.,0.);vec3 q0=P*vec3(.28,1.1,1.1)+uSeed;
    vec2 q=vP.yz+uRC+.34*vec2(vn(q0*vec3(.55,.5,.5)),vn(q0*vec3(.55,.5,.5)+9.2))-.17;
    float r=length(q)+.035*fb(P*vec3(.7,2.2,2.2));float rr=r*uRF;float g=fract(rr);float wd=.75+.25*vn(vec3(floor(rr)*3.7,uSeed,1.));
    float lt=smoothstep(.25,.93,g)*(1.-smoothstep(.95,1.,g))*wd;
    float fib=fb(P*vec3(1.6,70.,70.));float pore=smoothstep(.62,.8,vn(P*vec3(9.,210.,210.)));
    float en0=smoothstep(.5,.95,abs(normalize(vOn).x));vec3 c=mix(uB,uL,lt*(.62-.34*en0));
    c*=.84+.32*fib;c*=1.-.13*pore;c*=.94+.12*fb(P*vec3(.4,3.,3.));
    float en=abs(normalize(vOn).x);gEnd=en;c*=mix(1.,.72,smoothstep(.5,.95,en));gFib=fib;gLate=lt;diffuseColor.rgb=c;}`).replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
    roughnessFactor=mix(.5+.2*gFib,.82,smoothstep(.5,.95,gEnd))+.08*gLate;`);};
 m.customProgramCacheKey=()=>'kit-wood'+along;
 return m;}

// 面の質感：UVが無い形にも貼れる（sakan から）。動く物でも模様がずれないよう物の座標で貼る。
const SURF={
 plaster:{c:'#d8d2c6',s:.9,b:.016,r:.92,d(g,s){speckle(g,s,'#ececec',['#d6d6d6','#f8f8f8','#c9c9c9'],Math.round(s*s*.04),1.8);g.strokeStyle='#cfcfcf';for(let i=0;i<70;i++){g.globalAlpha=rnd(.05,.16);g.lineWidth=rnd(2,14);g.beginPath();const x=rnd(s),y=rnd(s);g.arc(x,y,rnd(s*.12,s*.5),rnd(6.28),rnd(6.28));g.stroke();}g.globalAlpha=1;}},
 clay:{c:'#8d7655',s:1.1,b:.03,r:.96,d(g,s){speckle(g,s,'#d8d8d8',['#b5b5b5','#f0f0f0','#9e9e9e','#c4c4c4'],Math.round(s*s*.05),2.4);g.lineCap='round';for(let i=0;i<560;i++){g.globalAlpha=rnd(.1,.36);g.strokeStyle=i%2?'#7d7d7d':'#fbfbfb';g.lineWidth=rnd(.5,1.4);g.beginPath();const x=rnd(s),y=rnd(s),a=rnd(6.28),l=rnd(5,26);g.moveTo(x,y);g.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke();}g.globalAlpha=1;}},
 soil:{c:'#5a4332',s:1,b:.05,r:.98,d(g,s){speckle(g,s,'#c8c8c8',['#8f8f8f','#e2e2e2','#6e6e6e','#b2b2b2'],Math.round(s*s*.05),3.2);for(let i=0;i<Math.round(s*.16);i++){const x=rnd(s),y=rnd(s),r=rnd(3,9);g.globalAlpha=rnd(.4,.8);g.fillStyle=['#a5a5a5','#8a8a8a','#dcdcdc'][i%3];g.beginPath();g.ellipse(x,y,r,r*rnd(.55,.85),rnd(3),0,7);g.fill();}g.globalAlpha=1;}},
 gravel:{c:'#88857d',s:1.4,b:.07,r:.94,d(g,s){g.fillStyle='#5c5c5c';g.fillRect(0,0,s,s);for(let i=0;i<Math.round(s*2.2);i++){const x=rnd(s),y=rnd(s),r=rnd(4,12);g.globalAlpha=rnd(.7,1);const v=Math.floor(rnd(120,235));g.fillStyle=`rgb(${v},${v},${v})`;g.beginPath();g.ellipse(x,y,r,r*rnd(.6,.9),rnd(3),0,7);g.fill();g.globalAlpha=.22;g.fillStyle='#fff';g.beginPath();g.ellipse(x-r*.25,y-r*.25,r*.4,r*.28,rnd(3),0,7);g.fill();}g.globalAlpha=1;}},
 concrete:{c:'#8f8f8a',s:.9,b:.02,r:.9,d(g,s){speckle(g,s,'#dedede',['#c4c4c4','#f2f2f2','#adadad'],Math.round(s*s*.05),1.6);for(let i=0;i<Math.round(s*.5);i++){g.globalAlpha=rnd(.2,.6);g.fillStyle='#6d6d6d';g.beginPath();g.arc(rnd(s),rnd(s),rnd(.6,2.6),0,7);g.fill();}g.globalAlpha=1;}},
 asphalt:{c:'#3a3b3e',s:1.5,b:.03,r:.86,d(g,s){g.fillStyle='#bdbdbd';g.fillRect(0,0,s,s);for(let i=0;i<Math.round(s*s*.06);i++){g.globalAlpha=rnd(.08,.42);g.fillStyle=['#e6e6e6','#7a7a7a','#ffffff','#969696'][i%4];g.fillRect(rnd(s),rnd(s),rnd(.8,2.4),rnd(.8,2.4));}g.globalAlpha=1;}},
 paper:{c:'#e7e1d2',s:.8,b:.006,r:.95,d(g,s){speckle(g,s,'#f2f2f2',['#e4e4e4','#fafafa'],Math.round(s*s*.012),1.2);g.lineCap='round';for(let i=0;i<Math.round(s*1.1);i++){g.globalAlpha=rnd(.05,.18);g.strokeStyle=i%3?'#cfcfcf':'#ffffff';g.lineWidth=rnd(.4,1);g.beginPath();const x=rnd(s),y=rnd(s),a=rnd(6.28),l=rnd(8,44);g.moveTo(x,y);g.quadraticCurveTo(x+Math.cos(a)*l*.5+rnd(-5,5),y+Math.sin(a)*l*.5+rnd(-5,5),x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke();}g.globalAlpha=1;}},
 cloth:{c:'#7c8a94',s:2.4,b:.012,r:.97,d(g,s){g.fillStyle='#dcdcdc';g.fillRect(0,0,s,s);const st=s/128;for(let i=0;i<128;i++){g.globalAlpha=.22;g.fillStyle=i%2?'#ffffff':'#9a9a9a';g.fillRect(i*st,0,st*.6,s);g.fillRect(0,i*st,s,st*.6);}g.globalAlpha=1;}},
 stone:{c:'#7a7872',s:.8,b:.04,r:.92,d(g,s){speckle(g,s,'#cdcdcd',['#a6a6a6','#e3e3e3','#8d8d8d'],Math.round(s*s*.03),2.5);for(let i=0;i<34;i++){g.globalAlpha=rnd(.04,.12);g.fillStyle=i%2?'#fff':'#555';g.beginPath();g.ellipse(rnd(s),rnd(s),rnd(s*.05,s*.24),rnd(s*.03,s*.14),rnd(3),0,7);g.fill();}g.globalAlpha=1;}},
 rust:{c:'#7a4a2c',s:1.2,b:.03,r:.95,d(g,s){speckle(g,s,'#c9c9c9',['#8d8d8d','#ececec','#6f6f6f'],Math.round(s*s*.05),3);for(let i=0;i<60;i++){g.globalAlpha=rnd(.08,.22);g.fillStyle=i%2?'#ffffff':'#5a5a5a';g.beginPath();g.ellipse(rnd(s),rnd(s),rnd(10,70),rnd(8,44),rnd(3),0,7);g.fill();}g.globalAlpha=1;}},
 sand:{c:'#b9a07a',s:1.3,b:.02,r:.97,d(g,s){speckle(g,s,'#dcdcdc',['#bebebe','#f4f4f4','#a8a8a8'],Math.round(s*s*.09),1.1);}},
};
const surfTex={};
function surface(kind,o={}){const d=SURF[kind];if(!d)bad('surface','種類は '+Object.keys(SURF).join(' / '));
 const size=phone?512:1024;if(!surfTex[kind]){const keep=seed;seed=kind.length*7919+11;surfTex[kind]=tex(size,d.d);seed=keep;}
 const map=surfTex[kind];
 const m=new THREE.MeshStandardMaterial({color:color(o.color||d.c,'surface'),roughness:o.rough??d.r,metalness:o.metal||0,envMapIntensity:o.env??.45,side:o.side||THREE.FrontSide});
 const sc=(o.scale??1)*d.s,bu=o.bump??d.b;
 m.onBeforeCompile=sh=>{sh.uniforms.uTri={value:map};sh.uniforms.uScale={value:sc};sh.uniforms.uBump={value:bu};
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vOP;varying vec3 vON;').replace('#include <begin_vertex>','#include <begin_vertex>\nvOP=position;vON=normal;');
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
uniform sampler2D uTri;uniform float uScale,uBump;varying vec3 vOP;varying vec3 vON;
vec4 triS(vec3 p,vec3 n){vec3 b=pow(abs(n),vec3(4.));b/=b.x+b.y+b.z+1e-5;return texture2D(uTri,p.zy*uScale)*b.x+texture2D(uTri,p.xz*uScale)*b.y+texture2D(uTri,p.xy*uScale)*b.z;}`)
  .replace('#include <map_fragment>','#include <map_fragment>\nvec4 tC=triS(vOP,normalize(vON));diffuseColor.rgb*=tC.rgb;')
  .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
  {float hh=dot(tC.rgb,vec3(.33));vec3 dpx=dFdx(-vViewPosition),dpy=dFdy(-vViewPosition);float dhx=dFdx(hh),dhy=dFdy(hh);vec3 r1=cross(dpy,normal),r2=cross(normal,dpx);float det=dot(dpx,r1);vec3 gr=sign(det)*(dhx*r1+dhy*r2);normal=normalize(abs(det)*normal-uBump*gr);}`);};
 m.customProgramCacheKey=()=>'kit-surface';
 return m;}

// ===== 形 =====
function place(m,o,name){if(o.at){vec3(name,o.at);m.position.set(...o.at);}if(o.rot){vec3(name,o.rot);m.rotation.set(...o.rot);}
 if(o.scale!==undefined){if(Array.isArray(o.scale))m.scale.set(...o.scale);else m.scale.setScalar(o.scale);}
 if(o.name)m.name=String(o.name);if(o.backdrop)m.userData.backdrop=true;(o.parent||scene).add(m);return m;}
function mesh(geo,mat,o={},name='part'){if(!mat||!mat.isMaterial)bad(name,'材質がありません。K.std / K.wood / K.surface などを渡す');
 const m=new THREE.Mesh(geo,mat);const sh=o.shadow!==false;m.castShadow=sh;m.receiveShadow=sh;return place(m,o,name);}
const box=(w,h,d,mat,o)=>mesh(new THREE.BoxGeometry(w,h,d),mat,o,'box');
const rbox=(w,h,d,r,mat,o)=>mesh(new RoundedBoxGeometry(w,h,d,3,Math.min(r,Math.min(w,h,d)/2-1e-4)),mat,o,'rbox');
const cyl=(rt,rb,h,mat,o={})=>mesh(new THREE.CylinderGeometry(rt,rb,h,o.seg||32),mat,o,'cyl');
const ball=(r,mat,o={})=>mesh(new THREE.SphereGeometry(r,o.seg||32,Math.round((o.seg||32)*.7)),mat,o,'ball');
const plane=(w,h,mat,o={})=>mesh(new THREE.PlaneGeometry(w,h,o.segX||1,o.segY||1),mat,o,'plane');
const lathe=(pts,mat,o={})=>{if(!Array.isArray(pts)||pts.length<2)bad('lathe','[半径,高さ] を2つ以上');return mesh(new THREE.LatheGeometry(pts.map(a=>new THREE.Vector2(a[0],a[1])),o.seg||48),mat,o,'lathe');};
const shape=(pts,depth,mat,o={})=>{if(!Array.isArray(pts)||pts.length<3)bad('shape','[x,y] を3つ以上');const g=new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(a=>new THREE.Vector2(a[0],a[1]))),{depth,bevelEnabled:!!o.bevel,bevelSize:o.bevel||0,bevelThickness:o.bevel||0,bevelSegments:2,steps:1});return mesh(g,mat,o,'shape');};
const tube=(pts,r,mat,o={})=>{if(!Array.isArray(pts)||pts.length<2)bad('tube','[x,y,z] を2つ以上');return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(a=>V(...a))),o.seg||64,r,o.round||12,false),mat,o,'tube');};
const group=(o={})=>place(new THREE.Group(),o,'group');
function ground(kind='concrete',o={}){const s=o.size||60;const m=plane(s,s,surface(kind,o),{rot:[-Math.PI/2,0,0],at:[0,o.y||0,0],name:o.name||'床',backdrop:true});m.castShadow=false;return m;}
function wall(kind='plaster',o={}){const w=o.width||60,h=o.height||24;const m=plane(w,h,surface(kind,o),{at:[0,h/2+(o.y||0),o.z??-4],name:o.name||'壁',backdrop:true});m.castShadow=false;return m;}

// 物を出す・消す（複数の物で材質を分けて持つ）
function cloneMat(m){const c=m.clone();c.onBeforeCompile=m.onBeforeCompile;if(m.customProgramCacheKey)c.customProgramCacheKey=m.customProgramCacheKey;return c;}
function fade(obj,o){if(!obj||!obj.traverse)bad('fade','物を渡す');const a=clamp(o);obj.visible=a>.003;if(!obj.visible)return obj;
 obj.traverse(n=>{if(!n.isMesh)return;if(!n.userData.fm){const f=cloneMat(n.material);f.transparent=true;f.userData.base=n.material.opacity;n.userData.fm=f;n.material=f;}
  const f=n.userData.fm;f.opacity=f.userData.base*a;f.depthWrite=a>=.98&&!f.userData.noDepth;n.castShadow=a>.5&&n.userData.noShadow!==true;});return obj;}

// ===== 粒（数と明るさに上限。粒で中が見えなくならないように）=====
const softTex=tex(64,(g,s)=>{const r=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);r.addColorStop(0,'rgba(255,255,255,1)');r.addColorStop(.4,'rgba(255,255,255,.7)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,s,s);});
const pxU={value:1};
let budget=phone?420:700;
function points(o,kind){const want=Math.round(o.n??(kind==='mist'?20:140)),cap=kind==='mist'?30:260,n=Math.max(0,Math.min(want,cap,budget));budget-=n;
 const at=vec3(kind,o.at||[0,0,0]),sp=vec3(kind,o.spread||[1,1,1]),ve=vec3(kind,o.vel||[0,.2,0]);
 const pos=new Float32Array(n*3),vel=new Float32Array(n*3),rn=new Float32Array(n);
 for(let i=0;i<n;i++){pos[i*3]=at[0]+rnd(-sp[0],sp[0]);pos[i*3+1]=at[1]+rnd(-sp[1],sp[1]);pos[i*3+2]=at[2]+rnd(-sp[2],sp[2]);
  vel[i*3]=ve[0]*rnd(.5,1.2)+rnd(-.12,.12);vel[i*3+1]=ve[1]*rnd(.5,1.2)+rnd(-.12,.12);vel[i*3+2]=ve[2]*rnd(.5,1.2)+rnd(-.12,.12);rn[i]=rand();}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('aV',new THREE.BufferAttribute(vel,3));g.setAttribute('aR',new THREE.BufferAttribute(rn,1));
 const maxA=kind==='mist'?.3:.7,sz=kind==='mist'?Math.min(o.size||1.1,2):Math.min(o.size||.03,.07);
 const u={uK:{value:0},uA:{value:0},uPx:pxU,uTex:{value:softTex},uS:{value:sz},uG:{value:o.gravity||0},uC:{value:new THREE.Color(o.color||(kind==='mist'?'#cfd8df':'#ffffff'))}};
 const pts=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,
  vertexShader:`attribute vec3 aV;attribute float aR;uniform float uK,uPx,uS,uG;varying float vR;void main(){vR=aR;vec3 p=position+aV*uK;p.y-=uG*uK*uK;vec4 mv=viewMatrix*modelMatrix*vec4(p,1.);gl_PointSize=min(uPx*uS*(.7+.6*aR)*900./max(.3,-mv.z),220.);gl_Position=projectionMatrix*mv;}`,
  fragmentShader:`uniform sampler2D uTex;uniform float uA;uniform vec3 uC;varying float vR;void main(){float a=texture2D(uTex,gl_PointCoord).a*uA*(.6+.4*vR);if(a<.004)discard;gl_FragColor=vec4(uC,a);}`}));
 pts.frustumCulled=false;pts.renderOrder=6;pts.userData.fx=true;pts.visible=false;(o.parent||scene).add(pts);
 return{obj:pts,set(k,a=1){u.uK.value=k;u.uA.value=clamp(a)*maxA;pts.visible=u.uA.value>.004;return this;}};}
const dust=(o={})=>points(o,'dust');
const mist=(o={})=>points(o,'mist');

// 目印の輪・矢印（光らせる場所は1場面に1つまで）
function ring(at,r=.5,c,o={}){const m=new THREE.Mesh(new THREE.TorusGeometry(r,Math.max(.012,r*.035),12,64),new THREE.MeshBasicMaterial({color:new THREE.Color(c||S.accent||'#ffc25a'),transparent:true,opacity:0,toneMapped:false,depthWrite:false}));m.userData.fx=true;m.renderOrder=7;place(m,{at,rot:o.rot||[0,0,0],parent:o.parent},'ring');m.visible=false;
 return{obj:m,set(a){m.material.opacity=clamp(a);m.visible=a>.01;return this;}};}
function arrow(from,to,c,o={}){const f=V(...vec3('arrow',from)),t=V(...vec3('arrow',to)),d=t.clone().sub(f),L=d.length()||1,w=o.width||L*.05;
 const mat=new THREE.MeshBasicMaterial({color:new THREE.Color(c||S.accent||'#ffc25a'),transparent:true,opacity:0,toneMapped:false,depthWrite:false});
 const g=new THREE.Group();const sh=new THREE.Mesh(new THREE.CylinderGeometry(w*.5,w*.5,L*.78,16),mat);sh.position.y=L*.39;const he=new THREE.Mesh(new THREE.ConeGeometry(w*1.5,L*.22,20),mat);he.position.y=L*.89;g.add(sh,he);
 g.position.copy(f);g.quaternion.setFromUnitVectors(V(0,1,0),d.clone().normalize());g.userData.fx=true;sh.userData.fx=he.userData.fx=true;g.renderOrder=7;(o.parent||scene).add(g);g.visible=false;
 return{obj:g,set(a){mat.opacity=clamp(a);g.visible=a>.01;return this;}};}

// 物に付ける名札（1場面3つまで）。on に場面IDを渡すとその場面だけ出る。
const labelsEl=$('labels'),labels=[];
function label(text,at,o={}){const d=document.createElement('div');d.className='lb r';d.textContent=String(text).slice(0,24);d.prepend(document.createElement('i'));labelsEl.append(d);
 const l={text:String(text).slice(0,24),el:d,at:V(...vec3('label',at)),on:o.on||null,from:+o.from||0,o:0,obj:o.follow||null};if(l.on&&!CHI[l.on])bad('label','場面IDがありません: '+l.on);labels.push(l);return{set(a){l.manual=clamp(a);return this;}};}
const ph=new THREE.Vector3();
function labelsAt(p,w,h,cb){for(const l of labels){const o=l.manual!==undefined?l.manual:l.on?on(l.on,p)*(l.from?go(l.on,l.from,Math.min(1,l.from+.08),p):1):0;l.o=o;if(o<=.01){cb(l,0,0,0,false);continue;}
 ph.copy(l.at);if(l.obj)l.obj.localToWorld(ph);ph.project(camera);const sx=(ph.x+1)/2*w,sy=(1-ph.y)/2*h,flip=sx>w*.8;cb(l,o,sx,sy,flip);}}

// ===== 光（デモで使っている組をそのまま）=====
let lightDone=false;
const LIGHTS={
 workshop(sz){const hemi=new THREE.HemisphereLight(0xfff0dd,0x2a1c14,.9);const key=new THREE.DirectionalLight(0xfff0dd,2.4);key.position.set(sz*.6,sz*1.2,sz*.75);const rim=new THREE.DirectionalLight(0x9fc0e6,.5);rim.position.set(-sz,sz*.6,-sz*.4);return{hemi,key,extra:[rim],bg:0x100c0a};},
 dusk(sz){const hemi=new THREE.HemisphereLight(0xcfdce8,0x3a2f24,.62);const key=new THREE.SpotLight(0xffe6c4,14*sz*sz/4,sz*7,.7,.95,1.6);key.position.set(-sz,sz*1.7,sz*1.4);const rim=new THREE.DirectionalLight(0x9fc0e6,.75);rim.position.set(sz,sz*.8,-sz*.2);const fr=new THREE.DirectionalLight(0xfff2de,.28);fr.position.set(sz*.3,sz*.5,sz*1.4);return{hemi,key,extra:[rim,fr],bg:0x0c1013};},
 day(sz){const hemi=new THREE.HemisphereLight(0xcfdcee,0x2a241e,1);const key=new THREE.DirectionalLight(0xfff0dd,2.2);key.position.set(sz*.8,sz*1.3,sz*1.2);return{hemi,key,extra:[],bg:0x33404f};},
 night(sz){const hemi=new THREE.HemisphereLight(0x8fa6c8,0x14161c,.42);const key=new THREE.DirectionalLight(0x9db6e0,1.25);key.position.set(sz*.3,sz*1.1,sz*1.5);const warm=new THREE.DirectionalLight(0xffc98a,.4);warm.position.set(-sz,sz*.4,sz*.6);return{hemi,key,extra:[warm],bg:0x070b13};},
};
function light(name='workshop',o={}){const f=LIGHTS[name];if(!f)bad('light','種類は '+Object.keys(LIGHTS).join(' / '));lightDone=true;const sz=o.size||6;
 const L=f(sz);scene.add(L.hemi,L.key,...L.extra);if(L.key.target)scene.add(L.key.target);
 if(o.target&&L.key.target)L.key.target.position.set(...vec3('light',o.target));
 L.key.castShadow=true;L.key.shadow.mapSize.set(2048,2048);
 if(L.key.isDirectionalLight)Object.assign(L.key.shadow.camera,{left:-sz*1.5,right:sz*1.5,top:sz*1.5,bottom:-sz*1.5,near:.5,far:sz*6});else{L.key.shadow.camera.near=1;L.key.shadow.camera.far=sz*8;}
 L.key.shadow.bias=-.0005;L.key.shadow.normalBias=.02;
 if(!S.night)scene.background=new THREE.Color(L.bg);return{hemi:L.hemi,key:L.key,extra:L.extra};}
const bg=c=>{scene.background=new THREE.Color(c);};
const fog=(c,near,far)=>{scene.fog=new THREE.Fog(new THREE.Color(c),near,far);};

// ===== 場面の進み具合 =====
let P=0;
const chapter=id=>{const c=CHI[id];if(!c)throw new Error(`場面ID「${id}」はありません。使えるのは ${CH.map(x=>x.id).join(', ')}`);return c;};
const go=(id,from=0,to=1,p=P)=>{const c=chapter(id),e=Math.min(c.b,1),s=e-c.a;return ss(c.a+s*from,c.a+s*to,p);};
const on=(id,p=P)=>{const c=chapter(id);return(c.first?1:ss(c.a-.014,c.a+.006,p))*(c.last?1:1-ss(c.b-.006,c.b+.014,p));};
const since=(id,p=P)=>{const c=chapter(id);return ss(c.a-.014,c.a+.006,p);};
const until=(id,p=P)=>{const c=chapter(id);return 1-ss(c.b-.006,c.b+.014,p);};

// ===== カメラ：Claude は「何を・どの大きさで・どちらから」だけ書く。距離は土台が決める =====
const dirOf=v=>{const d=V(...v);if(d.lengthSq()<1e-6)d.set(.5,.3,1);return d.normalize();};
const keys=[];
CH.forEach(c=>{const span=Math.min(c.b,1)-c.a,cs=c.cam;const k=(q,e)=>keys.push({p:c.a+span*q,look:V(...e.look),r:Math.max(.05,e.r),dir:dirOf(e.dir)});k(.12,cs[0]);k(.94,cs[1]||cs[0]);});
let portrait=false,W=0,H=0,forced=null;
function fitDist(r){const tv=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2),th=tv*camera.aspect,fy=portrait?.54:.84,fx=portrait?.94:.6;return Math.max(r/(tv*fy),r/(th*fx),r*1.7);}
const camLook=new THREE.Vector3(),camDir=new THREE.Vector3();let camR=1;
function camAt(p){let i=0;while(i<keys.length-2&&p>keys[i+1].p)i++;const a=keys[i],b=keys[i+1]||a,t=b===a?0:ss(a.p,b.p,p);
 camLook.copy(a.look).lerp(b.look,t);camDir.copy(a.dir).lerp(b.dir,t);if(camDir.lengthSq()<1e-4)camDir.copy(b.dir);camDir.normalize();camR=mix(a.r,b.r,t);
 camera.position.copy(camLook).addScaledVector(camDir,fitDist(camR));camera.lookAt(camLook);}

// ===== 字幕の下の幕（文字が背景に溶けないように、場面に関係なく常に敷く）=====
const SCRIM={h:[[0,.94],[.36,.86],[.5,.62],[.68,0]],v:[[0,.97],[.34,.9],[.48,.58],[.62,0]]};
const nc=new THREE.Color(S.night||'#0f1216').convertLinearToSRGB();const nightRGB=[nc.r,nc.g,nc.b].map(v=>Math.round(clamp(v)*255)).join(',');
function scrimCss(){const pt=portrait,s=SCRIM[pt?'v':'h'];$('scrim').style.background=`linear-gradient(${pt?'0deg':'90deg'},${s.map(([o,a])=>`rgba(${nightRGB},${a}) ${o*100}%`).join(',')})`;}

function resize(){W=forced?forced.w:innerWidth;H=forced?forced.h:innerHeight;portrait=forced?W/H<=1:(W<=760||W/H<=1);
 renderer.setPixelRatio(forced?1:Math.min(devicePixelRatio,2));renderer.setSize(W,H,false);camera.aspect=W/H;camera.fov=portrait?52:36;
 if(portrait)camera.setViewOffset(W,H,0,H*.2,W,H);else camera.setViewOffset(W,H,-W*.17,0,W,H);camera.updateProjectionMatrix();
 pxU.value=renderer.getPixelRatio()*H/900;scrimCss();}
addEventListener('resize',resize);resize();

// ===== 動き =====
let update=null,updateErr=null;
const hint=$('hint'),barI=document.querySelector('#bar i');
function apply(p,t){P=p;timeU.value=t;
 if(update&&!updateErr){try{update(p,t);}catch(e){updateErr=e;fail('場面の動きの中でエラー: '+(e&&e.message||e));}}
 camAt(p);afterCam();
 for(const x of caps){const o=capAlpha(x.c,p);x.el.style.opacity=o;x.el.style.visibility=o>.01?'visible':'hidden';x.el.style.pointerEvents=o>.8?'auto':'none';}
 hint.style.opacity=p<.03?1:0;barI.style.height=(p*100)+'%';
 if(!recording)labelsAt(p,W,H,(l,o,sx,sy,flip)=>{l.el.style.opacity=o;if(o<=.01)return;l.el.className='lb '+(flip?'l':'r');const dx=flip?-l.el.offsetWidth-30:30;l.el.style.transform=`translate(${sx+dx}px,${sy-11}px)`;});}
const prm=matchMedia('(prefers-reduced-motion: reduce)').matches;
const prog=()=>{const m=document.documentElement.scrollHeight-innerHeight;return m>0?Math.min(1,Math.max(0,scrollY/m)):0;};
let cur=prog(),last=performance.now(),tt=0,frozen=null,recording=false;
function draw(){renderer.render(scene,camera);}
function frame(now){if(!recording){const dt=Math.min(.05,(now-last)/1000);last=now;tt+=dt;
  const target=frozen??prog();cur+=(target-cur)*(frozen!==null||prm?1:Math.min(1,dt*5));
  apply(cur,prm?0:tt);draw();}
 requestAnimationFrame(frame);}
function seek(p){frozen=p;cur=p;tt+=.016;apply(p,tt);draw();return renderer.info.render.triangles;}
window.__seek=seek;window.__release=()=>{frozen=null;};

// ===== 字幕を絵の中に描く（動画と前後の見本に使う）=====
const FONT='"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif';
function runs(html){const out=[[]];let em=false;for(const part of String(html).split(/(<br\s*\/?>|<em>|<\/em>)/)){if(!part)continue;if(/^<br/.test(part)){out.push([]);continue;}if(part==='<em>'){em=true;continue;}if(part==='</em>'){em=false;continue;}
  out[out.length-1].push({t:part.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'),em});}return out;}
const NOHEAD='、。，．・：；？！）」』】〉》ーぁぃぅぇぉっゃゅょァィゥェォッャュョ〜…';
function wrap(g,lines,maxW){const res=[];for(const line of lines){let cur=[],w=0;const push=()=>{res.push(cur);cur=[];w=0;};
  for(const r of line)for(const ch of r.t){const cw=g.measureText(ch).width;if(w+cw>maxW&&cur.length){if(NOHEAD.includes(ch)){const prev=cur.pop();const carry=prev;push();cur.push(carry);w=g.measureText(carry.ch).width;}else push();}cur.push({ch,em:r.em});w+=cw;}
  push();}return res;}
function textLine(g,line,x,y,base,emC){let px=x;for(const c of line){g.fillStyle=c.em?emC:base;g.fillText(c.ch,px,y);px+=g.measureText(c.ch).width;}return px;}
function compose(g,w,h,p){g.drawImage(canvas,0,0,w,h);
 const pt=portrait,s=SCRIM[pt?'v':'h'],gr=pt?g.createLinearGradient(0,h,0,0):g.createLinearGradient(0,0,w,0);
 for(const[o,a]of s)gr.addColorStop(o,`rgba(${nightRGB},${a})`);g.fillStyle=gr;g.fillRect(0,0,w,h);
 const u=pt?w/390:w/1280,emC=S.accent||'#ffc25a',ink='#f6f3ec',mute='#d9d7d0';
 g.save();g.textBaseline='top';g.shadowColor='rgba(0,0,0,.8)';g.shadowBlur=6*u;
 labelsAt(p,w,h,(l,o,sx,sy,flip)=>{if(o<=.01)return;g.globalAlpha=o;g.font=`600 ${(pt?12.5:14)*u}px ${FONT}`;const tw=g.measureText(l.text).width,gap=30*u,tx=flip?sx-gap-tw:sx+gap;
  const pad=7*u,ls=(pt?12.5:14)*u;g.strokeStyle='rgba(255,255,255,.9)';g.lineWidth=Math.max(1,u);g.beginPath();g.moveTo(sx,sy);g.lineTo(flip?tx+tw+pad:tx-pad,sy);g.stroke();g.fillStyle='#fff';g.beginPath();g.arc(sx,sy,3*u,0,7);g.fill();
  g.save();g.shadowBlur=0;g.fillStyle='rgba(10,12,16,.68)';g.fillRect(tx-pad,sy-ls*.92,tw+pad*2,ls*1.84);g.restore();g.fillStyle='#fff';g.fillText(l.text,tx,sy-ls*.58);});
 g.globalAlpha=1;g.font=`500 ${(pt?11:13)*u}px ${FONT}`;g.fillStyle=ink;g.fillText(S.tag||'',(pt?14:64)*u,(pt?12:18)*u);
 if(S.note){const ns=(pt?10.5:12)*u;g.font=`400 ${ns}px ${FONT}`;const nl=wrap(g,[[{t:S.note,em:false}]],pt?w-44*u:w*.46),nh=ns*1.5;let nw=0;for(const l of nl){let lw=0;for(const r of l)lw+=g.measureText(r.ch).width;nw=Math.max(nw,lw);}
  const nx=pt?14*u:w-nw-28*u,ny=pt?32*u:14*u;g.save();g.shadowBlur=0;g.fillStyle='rgba(0,0,0,.55)';g.fillRect(nx-(pt?6:10)*u,ny-4*u,nw+(pt?12:20)*u,nh*nl.length+8*u);g.restore();g.fillStyle=mute;nl.forEach((l,i)=>textLine(g,l,nx,ny+i*nh,mute,mute));}
 if(S.test){g.font=`700 ${13*u}px ${FONT}`;const m='テスト（Claudeの返事は手書き）',tw=g.measureText(m).width,x=w-tw-(pt?24:34)*u,yy=(pt?76:46)*u;g.shadowBlur=0;g.fillStyle='#f2c230';g.fillRect(x,yy,tw+16*u,24*u);g.fillStyle='#111';g.fillText(m,x+8*u,yy+5*u);g.shadowBlur=6*u;}
 for(const x of caps){const c=x.c,o=capAlpha(c,p);if(o<=.01)continue;g.globalAlpha=o;
  const left=(pt?20:64)*u,width=pt?w-40*u:w*.42,hs=(pt?28:45)*u,bs=(pt?14.5:17)*u;
  g.font=`800 ${hs}px ${FONT}`;const tl=wrap(g,runs(c.title),width);g.font=`400 ${bs}px ${FONT}`;const bl=wrap(g,runs(c.body),width);
  let askL=[];const as=(pt?13:14)*u;if(c.confirm){g.font=`400 ${as}px ${FONT}`;askL=wrap(g,[[{t:c.confirm,em:false}]],width-24*u);}
  const imgOn=!!(c.image_note||c.img),is=(pt?11.5:13)*u;let imgL=[];if(imgOn){g.font=`400 ${is}px ${FONT}`;imgL=wrap(g,[[{t:imgText(c),em:false}]],width-74*u);}const iL=is*1.5,imgH=imgOn?iL*Math.max(1,imgL.length)+10*u:0;
  const hL=hs*1.32,bL=bs*1.8,aL=as*1.55,askH=c.confirm?(aL*(askL.length+1)+16*u):0,total=imgH+hL*tl.length+hs*.5+bL*bl.length+(c.confirm?12*u+askH:0);
  let y=pt?h-24*u-total:(h-total)/2;
  if(imgOn){g.font=`700 ${is}px ${FONT}`;const lb='イメージ',lw=g.measureText(lb).width;g.save();g.shadowBlur=0;g.fillStyle=emC;g.fillRect(left,y-1*u,lw+14*u,iL+2*u);g.fillStyle='#111';g.fillText(lb,left+7*u,y+1*u);g.restore();g.font=`400 ${is}px ${FONT}`;imgL.forEach((l,i)=>textLine(g,l,left+lw+22*u,y+1*u+i*iL,mute,mute));y+=imgH;}
  g.font=`800 ${hs}px ${FONT}`;for(const l of tl){textLine(g,l,left,y,ink,emC);y+=hL;}y+=hs*.5;
  g.font=`400 ${bs}px ${FONT}`;for(const l of bl){textLine(g,l,left,y,mute,emC);y+=bL;}
  if(c.confirm){y+=12*u;g.shadowBlur=0;g.fillStyle='rgba(0,0,0,.45)';g.fillRect(left,y,width,askH);g.fillStyle='#f2c230';g.fillRect(left,y,5*u,askH);g.font=`700 ${as}px ${FONT}`;g.fillText('ここは職人に確認',left+14*u,y+8*u);g.font=`400 ${as}px ${FONT}`;let yy=y+8*u+aL;for(const l of askL){textLine(g,l,left+14*u,yy,ink,emC);yy+=aL;}g.shadowBlur=6*u;}
 }
 g.restore();g.globalAlpha=1;}

// ===== 見本の絵を返す =====
function shot(p,w,h,kind){const keepF=forced,keepFr=frozen;forced={w,h};resize();seek(p);const c=document.createElement('canvas');c.width=w;c.height=h;compose(c.getContext('2d'),w,h,p);const url=c.toDataURL('image/jpeg',.86);forced=keepF;resize();frozen=keepFr;seek(keepFr??cur);if(keepFr===null)frozen=null;return url;}

// ===== 試しに動かす（作った直後の確認）=====
function visibleChain(o){for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;}
function blocker(){const dir=camLook.clone().sub(camera.position),dist=dir.length();dir.normalize();const ray=new THREE.Raycaster(camera.position.clone(),dir,.01,dist*.55);
 for(const h of ray.intersectObjects(scene.children,true)){const o=h.object;if(!o.isMesh||o.userData.fx||!visibleChain(o))continue;let back=false;for(let n=o;n;n=n.parent)if(n.userData.backdrop||n.userData.fx)back=true;if(back)continue;if((o.material.opacity??1)<.45)continue;return o.name||(o.parent&&o.parent.name)||'名前のない物';}return null;}
// 読み込み直後の iframe は、まだ大きさが届いていないことがある（裏のタブで実測）。測る前に待つ
async function settleViewport(){const qq=new URLSearchParams(location.search),vw=+qq.get('vw')||0,vh=+qq.get('vh')||0,t0=performance.now();const good=()=>vw?(innerWidth===vw&&innerHeight===vh):(innerWidth>0&&innerHeight>0);
 while(!good()&&performance.now()-t0<4000)await new Promise(r=>setTimeout(r,40));resize();return good();}
// 名札の先に、本当に物が見えるか（「灯油のあと」の先に何も無かった実例から）
function labelTrouble(w,h,pt,say2){labelsAt(P,w,h,(l,o,sx,sy)=>{if(o<.5)return;const wp=l.at.clone();if(l.obj)l.obj.localToWorld(wp);const q=wp.clone().project(camera);
 if(q.z>1||Math.abs(q.x)>1||Math.abs(q.y)>1){say2(`名札「${l.text}」の先が画面の外です`);return;}
 if(pt?sy>h*.6:sx<w*.36){say2(`名札「${l.text}」の先が字幕の下に隠れています`);return;}
 const tol=Math.max(.2,camR*.13);for(const t of imgTargets)if(t.alpha>.05&&t.pos.distanceTo(wp)<=t.r*1.25+tol*.5)return;
 const from=camera.position.clone(),dir=wp.clone().sub(from),dist=dir.length();dir.normalize();let hit=null;
 for(const r of new THREE.Raycaster(from,dir,.01,dist*3).intersectObjects(scene.children,true)){const n=r.object;if(!n.isMesh||n.userData.fx||!visibleChain(n)||n.material.visible===false)continue;if((n.material.opacity??1)<.2)continue;let back=false;for(let a=n;a;a=a.parent)if(a.userData.backdrop||a.userData.fx)back=true;if(back)continue;hit=r;break;}
 if(!hit){say2(`名札「${l.text}」の先に物が見えません`);return;}
 if(hit.point.distanceTo(wp)>tol)say2(hit.distance<dist?`名札「${l.text}」の先の物が、別の物に隠れています`:`名札「${l.text}」の先に物が見えません`);});}
async function runCheck(){const vp0=[innerWidth,innerHeight],vpOk=await settleViewport();const out={kit:'check',ok:true,errors:[],warnings:[],stats:{asks:0,vp0,vp:[innerWidth,innerHeight],vpOk}};
 if(window.__ERR.length){out.ok=false;out.broken=true;out.lines=window.__ERR.map(e=>e.line||0);out.errors=[...new Set(window.__ERR.map(e=>e.message+(e.line?`（${e.line}行）`:'')))];return out;}  // 動いていないなら、絵の検査はしない（元の原因だけ返す）
 if(!vpOk)out.warnings.push('確かめる画面の大きさが届かなかったので、字幕のはみ出しは確かめられませんでした');
 for(const x of caps){const c=x.c;seek(c.a+(Math.min(c.b,1)-c.a)*.5);const r=x.el.getBoundingClientRect();if(vpOk&&(r.top<-1||r.bottom>innerHeight+1))out.errors.push(`場面「${c.id}」: 字幕が画面からはみ出しています`);
  if(c.confirm){const a=x.el.querySelector('.ask'),st=getComputedStyle(x.el);if(!a||st.visibility==='hidden'||+st.opacity<.5||a.offsetHeight<10)out.errors.push(`場面「${c.id}」: 「ここは職人に確認」が画面に出ていません`);else out.stats.asks++;}}
 const keepF=forced;forced={w:640,h:360};resize();
 const small=document.createElement('canvas');small.width=48;small.height=27;const g=small.getContext('2d',{willReadFrequently:true});
 const sigs=[];let times=[];
 for(const c of CH){const e=Math.min(c.b,1);let sig=null;
  for(const q of[.3,.92]){const t0=performance.now();const tris=seek(c.a+(e-c.a)*q);times.push(performance.now()-t0);out.stats.tris=Math.max(out.stats.tris||0,tris);
   if(updateErr){out.broken=true;out.errors.push(`場面「${c.id}」: ${updateErr.message||updateErr}`);break;}
   g.drawImage(canvas,0,0,48,27);const d=g.getImageData(18,0,30,27).data;let m=0,v=0,n=d.length/4;const ls=[];for(let i=0;i<d.length;i+=4){const l=(.2126*d[i]+.7152*d[i+1]+.0722*d[i+2])/255;ls.push(l);m+=l;}m/=n;for(const l of ls)v+=(l-m)*(l-m);v=Math.sqrt(v/n);
   if(v<.012)out.errors.push(`場面「${c.id}」: 画面がほぼ一色で、物が映っていません（明るさ${m.toFixed(2)}）。カメラの向きか大きさ(r)を直す`);
   else if(m>.8)out.errors.push(`場面「${c.id}」: 白くとびすぎです（明るさ${m.toFixed(2)}）`);
   else if(m<.018)out.errors.push(`場面「${c.id}」: 暗すぎて見えません（明るさ${m.toFixed(2)}）`);
   const b=blocker();if(b)out.errors.push(`場面「${c.id}」: カメラの前を「${b}」がふさいでいます。向き(dir)を変えるか、その物を消す`);
   sig=ls;}
  if(updateErr)break;
  sigs.push(sig);}
 if(!updateErr)for(let i=1;i<sigs.length;i++){let d=0;for(let j=0;j<sigs[i].length;j++)d+=Math.abs(sigs[i][j]-sigs[i-1][j]);d/=sigs[i].length;if(d<.004)out.warnings.push(`場面「${CH[i].id}」と前の場面の絵がほとんど同じです`);}
 let meshes=0;scene.traverse(o=>{if(o.isMesh)meshes++;});out.stats.meshes=meshes;out.stats.buildMs=Math.round(buildMs);out.stats.frameMs=Math.round(times.slice(-6).reduce((a,b)=>a+b,0)/Math.max(1,times.slice(-6).length));out.stats.programs=renderer.info.programs?renderer.info.programs.length:0;
 if(meshes<3)out.errors.push(`物が${meshes}個しかありません`);
 if(S.kit>=2&&!updateErr){
  if(!worldUsed)out.errors.push('その仕事らしい場所がありません。K.world で場所を作る');
  for(const c of CH){const n=labels.filter(l=>l.on===c.id).length;if(n>3)out.errors.push(`場面「${c.id}」: 名札が${n}つあります。1場面3つまで`);}
  for(const[vw,vh,pt,tag]of[[640,360,false,''],[360,640,true,'（スマホ）']]){forced={w:vw,h:vh};resize();for(const c of CH)for(const q of[.55,.92]){seek(c.a+(Math.min(c.b,1)-c.a)*q);labelTrouble(vw,vh,pt,m=>{const e=`場面「${c.id}」${tag}: ${m}`;if(!out.errors.includes(e))out.errors.push(e);});}}
  for(const x of caps){if(x.c.image_note||x.c.img){const d=x.el.querySelector('.imgp');if(!d||d.hidden)out.errors.push(`場面「${x.c.id}」: 「イメージ」の印が出ていません`);}}
  for(const c of CH)out.stats.img=(out.stats.img||0)+(c.image_note||c.img?1:0);
 }
 if((out.stats.tris||0)>2500000)out.errors.push(`形が細かすぎて重すぎます（三角形${out.stats.tris}個）`);
 if(window.__ERR.length){out.broken=true;out.lines=window.__ERR.map(e=>e.line||0);for(const e of window.__ERR)out.errors.push(e.message+(e.line?`（${e.line}行）`:''));}
 forced=keepF;resize();frozen=null;
 const errs=[...new Set(out.errors)];out.errors=errs;out.ok=errs.length===0;return out;}

// ===== 動画に保存（字幕ごと絵に描いて録る。ブラウザの中だけで完結）=====
let recStop=null;
function record(o){if(recording)return;const w=o.w||1280,h=o.h||720,seconds=o.seconds||Math.max(20,N*7);
 const types=['video/mp4;codecs=avc1.42E01F','video/mp4','video/webm;codecs=vp9','video/webm'];const type=types.find(t=>window.MediaRecorder&&MediaRecorder.isTypeSupported(t));
 if(!type||!canvas.captureStream){say({kit:'rec_error',message:'このブラウザでは動画に保存できません'});return;}
 const view=$('recView');view.width=w;view.height=h;const g=view.getContext('2d');
 const keepF=forced,keepFr=frozen,keepY=scrollY;recording=true;forced={w,h};resize();document.body.classList.add('rec');
 const stream=view.captureStream(30);const chunks=[];const mr=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:h>=1080||w>=1080?9000000:6000000});
 mr.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
 let stopped=false;
 const finish=()=>{document.body.classList.remove('rec');recording=false;forced=keepF;resize();frozen=keepFr;scrollTo(0,keepY);last=performance.now();};
 mr.onstop=()=>{finish();if(recStop==='cancel'){recStop=null;say({kit:'rec_cancelled'});return;}recStop=null;say({kit:'recorded',blob:new Blob(chunks,{type}),type,seconds,w,h});};
 const lead=.6,tail=1.2,total=seconds+lead+tail;let st=null,lastSay=0;
 const step=()=>{if(stopped)return;const now=performance.now();if(st===null)st=now;const el=(now-st)/1000;
  if(recStop==='cancel'||el>=total){stopped=true;if(mr.state!=='inactive')mr.stop();return;}
  const p=clamp((el-lead)/seconds);tt=el;apply(p,prm?0:el);draw();compose(g,w,h,p);
  if(now-lastSay>300){lastSay=now;say({kit:'rec_progress',el,total});}
  if(document.hidden)setTimeout(step,33);else requestAnimationFrame(step);};
 apply(0,0);draw();compose(g,w,h,0);mr.start(1000);step();}

// ===== 親の画面とのやりとり（親はこのページの中を見られない。伝言だけ）=====
let picking=false,pickDot=null,downAt=null;
const curChapter=p=>{let best=CH[0];for(const c of CH)if(p>=c.a-.02)best=c;return best.id;};
function pickAt(cx,cy){const nd=new THREE.Vector2(cx/innerWidth*2-1,-(cy/innerHeight)*2+1),ray=new THREE.Raycaster();ray.setFromCamera(nd,camera);
 for(const h of ray.intersectObjects(scene.children,true)){const o=h.object;if(!o.isMesh||o.userData.fx||!visibleChain(o)||o.material.visible===false||(o.material.opacity??1)<.2)continue;let name=o.name,n=o.parent;while(!name&&n){name=n.name;n=n.parent;}
  if(!pickDot){pickDot=new THREE.Mesh(new THREE.SphereGeometry(.05,16,12),new THREE.MeshBasicMaterial({color:0xf2c230,toneMapped:false,depthTest:false}));pickDot.renderOrder=9;pickDot.userData.fx=true;scene.add(pickDot);}
  pickDot.visible=true;pickDot.position.copy(h.point);pickDot.scale.setScalar(Math.max(.4,camR*.5));
  return{name:name||'名前のない物',point:[+h.point.x.toFixed(2),+h.point.y.toFixed(2),+h.point.z.toFixed(2)]};}return null;}
canvas.addEventListener('pointerdown',e=>{if(picking)downAt={x:e.clientX,y:e.clientY,t:performance.now()};});
canvas.addEventListener('pointerup',e=>{if(!picking||!downAt)return;const moved=Math.hypot(e.clientX-downAt.x,e.clientY-downAt.y),quick=performance.now()-downAt.t<600;downAt=null;if(moved>7||!quick)return;const r=pickAt(e.clientX,e.clientY);say({kit:'picked',hit:r});});
addEventListener('message',e=>{if(e.source!==window.parent||window.parent===window)return;const m=e.data||{};
 if(m.kit==='seek'){seek(+m.p||0);}
 else if(m.kit==='release'){frozen=null;}
 else if(m.kit==='goto'){frozen=null;scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*clamp(+m.p||0));}
 else if(m.kit==='pick'){picking=!!m.on;if(!picking&&pickDot)pickDot.visible=false;}
 else if(m.kit==='shot'){say({kit:'shot',tag:m.tag,url:shot(+m.p||0,m.w||640,m.h||360)});}
 else if(m.kit==='record'){record(m);}
 else if(m.kit==='rec_cancel'){recStop='cancel';}
});
let lastP=-1;setInterval(()=>{if(recording)return;if(Math.abs(cur-lastP)>.002){lastP=cur;say({kit:'state',p:+cur.toFixed(4),chapter:curChapter(cur)});}},250);

/*{{PARTS}}*/

// ===== 組み立て =====
const K={THREE,scene,camera,V,rnd,ss,mix,clamp,seq,tex,speckle,
 std,metal,glass,emit,water,wood,surface,
 box,rbox,cyl,ball,plane,lathe,shape,tube,group,ground,wall,
 world,car,house,bottle,wheel,loft,pillow,strata,xray,cut,stain,wisp,flow,spray,glow,blob,
 fade,dust,mist,ring,arrow,label,light,bg,fog,go,on,since,until,phone};
let buildMs=0,ran=false;
const q=new URLSearchParams(location.search);
window.__KIT={run(fn){ran=true;const t0=performance.now();
  try{const r=fn(K);if(typeof r!=='function')throw new Error('最後に function(p,t){...} を return していません');update=r;}
  catch(e){console.error(e);fail('物を作る所でエラー: '+(e&&e.message||e));$('err').style.display='block';say({kit:'ready',ok:false});if(q.has('check'))runCheckAndSay();return;}
  if(!lightDone)light('workshop');buildMs=performance.now()-t0;
  try{for(const c of CH){const e=Math.min(c.b,1);let any=false;for(const q of[.25,.55,.9]){const pp=c.a+(e-c.a)*q;P=pp;update(pp,0);if(imgTargets.some(t=>t.alpha>.05)){any=true;break;}}c.img=any;}P=0;update(0,0);}catch(e){}
  showImgMarks();
  if(q.has('p')){frozen=+q.get('p');cur=frozen;}
  if(q.has('auto')){const s=+q.get('auto')||70,st=performance.now();(function a(n){const m=document.documentElement.scrollHeight-innerHeight,k=(n-st)/(s*1000);scrollTo(0,m*Math.min(1,k));if(k<1)requestAnimationFrame(a);})(st);}
  requestAnimationFrame(frame);
  say({kit:'ready',ok:true,chapters:CH.map(c=>({id:c.id,a:c.a,b:Math.min(c.b,1)}))});
  if(q.has('check'))runCheckAndSay();}};
async function runCheckAndSay(){let r;try{r=await runCheck();}catch(e){r={kit:'check',ok:false,errors:['確かめる途中でエラー: '+(e&&e.message||e)],warnings:[],stats:{}};}say(r);}
// コードが文法エラーで走らなかったときも、黙らず知らせる
addEventListener('load',()=>setTimeout(()=>{if(!ran){fail('場面のコードが動きませんでした');$('err').style.display='block';if(q.has('check'))say({kit:'check',ok:false,errors:window.__ERR.map(e=>e.message+(e.line?`（${e.line}行）`:'')),warnings:[],stats:{},syntax:true,lines:window.__ERR.map(e=>e.line||0)});}},60));
