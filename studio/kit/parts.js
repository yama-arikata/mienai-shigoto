// ===== 世界と主役の部品（kit.js の途中に差し込まれる）=====
// 「暗い床に箱」にならないように、場所の世界・本物らしい形・見えない物の見せ方をここで持つ。
const timeU={value:0};
const imgTargets=[];   // 見えない物（しみ・におい・流れ）。「イメージ」の印と名札の確かめに使う
const noRay=o=>{o.raycast=()=>{};return o;};
const pw=(v,e)=>Math.sign(v)*Math.pow(Math.abs(v),e);
const DEG=Math.PI/180;
const FX_OK=phone?.6:1;
function spl(T,x){const n=T.length;if(x<=T[0][0])return T[0][1];if(x>=T[n-1][0])return T[n-1][1];let i=0;while(i<n-2&&x>T[i+1][0])i++;
 const h=T[i+1][0]-T[i][0],t=(x-T[i][0])/h,m0=i>0?(T[i+1][1]-T[i-1][1])/(T[i+1][0]-T[i-1][0]):(T[i+1][1]-T[i][1])/h,m1=i<n-2?(T[i+2][1]-T[i][1])/(T[i+2][0]-T[i][0]):(T[i+1][1]-T[i][1])/h,t2=t*t,t3=t2*t;
 return(2*t3-3*t2+1)*T[i][1]+(t3-2*t2+t)*h*m0+(-2*t3+3*t2)*T[i+1][1]+(t3-t2)*h*m1;}

// 面を格子で作る（fn(u,v)→[x,y,z]）。closeV で輪に閉じる
function gridGeo(nu,nv,fn,closeV=false,index=null){const W=closeV?nv:nv+1,pos=new Float32Array((nu+1)*W*3),uv=new Float32Array((nu+1)*W*2);
 for(let i=0;i<=nu;i++)for(let j=0;j<W;j++){const p=fn(i/nu,j/nv),k=i*W+j;pos[k*3]=p[0];pos[k*3+1]=p[1];pos[k*3+2]=p[2];uv[k*2]=i/nu;uv[k*2+1]=j/nv;}
 const P=(i,j)=>i*W+(closeV?j%nv:j),idx=[];
 for(let i=0;i<nu;i++)for(let j=0;j<nv;j++){if(index&&!index(i,j))continue;idx.push(P(i,j),P(i+1,j),P(i,j+1),P(i+1,j),P(i+1,j+1),P(i,j+1));}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('uv',new THREE.BufferAttribute(uv,2));g.setIndex(idx);return g;}
function capGeo(nr,pts){const pos=[],idx=[];let cx=0,cy=0,cz=0;for(const p of pts){cx+=p[0];cy+=p[1];cz+=p[2];pos.push(...p);}pos.push(cx/nr,cy/nr,cz/nr);for(let j=0;j<nr;j++)idx.push(nr,j,(j+1)%nr);
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);return g;}

// なめらかな胴体：x に沿って断面をつなぐ。fn(x,角度)→[y,z]
function loft(x0,x1,nx,nr,fn,mat,o={}){if(typeof fn!=='function')bad('loft','fn(x,角度) を渡す');
 const g=gridGeo(nx,nr,(u,v)=>{const x=mix(x0,x1,u),q=fn(x,v*Math.PI*2);return[x,q[0],q[1]];},true);g.computeVertexNormals();
 const m=mesh(g,mat,o,'loft');const cap=(x,flip)=>{const pts=[];for(let j=0;j<nr;j++){const q=fn(x,j/nr*Math.PI*2);pts.push([x,q[0],q[1]]);}const c=capGeo(nr,flip?pts:pts.slice().reverse());c.computeVertexNormals();const cm=new THREE.Mesh(c,mat);cm.castShadow=cm.receiveShadow=true;m.add(cm);};cap(x0,false);cap(x1,true);return m;}
// ふくらんだ布：座面・背もたれ・枕。puff がふくらみ
function pillowGeo(sx,sy,sz,r,puff,axis=1){const g=new RoundedBoxGeometry(sx,sy,sz,5,Math.min(r,Math.min(sx,sy,sz)/2-1e-3)),P=g.attributes.position,h=[sx/2,sy/2,sz/2],a1=(axis+1)%3,a2=(axis+2)%3;
 for(let i=0;i<P.count;i++){const v=[P.getX(i),P.getY(i),P.getZ(i)],n1=v[a1]/h[a1],n2=v[a2]/h[a2];v[axis]+=Math.sign(v[axis])*puff*(1-n1**4)*(1-n2**4);P.setXYZ(i,v[0],v[1],v[2]);}g.computeVertexNormals();return g;}
const pillow=(sx,sy,sz,r,puff,mat,o={})=>mesh(pillowGeo(sx,sy,sz,r,puff,o.axis??1),mat,o,'pillow');

// ===== 粘土：玉・カプセル・楕円・角丸箱を、なめらかにくっつけて1つの塊にする =====
// 距離の場（SDF）をなめらかに足し合わせ、格子で調べて面にする（surface nets）。面は場の上へ寄せ、法線は場の傾きから取る。
// 作るのは1回だけ。毎フレーム作り直さない。
const CLAY_KEYS=['ball','cap','ell','rbox'];
function clayBlobs(list){if(!Array.isArray(list)||!list.length)bad('clay','[{ball:[x,y,z],r},{cap:[[x,y,z],[x,y,z]],r},...] を渡す');const out=[];
 const one=(b,flip)=>{const k=CLAY_KEYS.find(k=>b[k]!==undefined);if(!k)bad('clay','1つずつ ball / cap / ell / rbox のどれかを書く');
  const fx=a=>flip?[-a[0],a[1],a[2]]:a,q={kind:k,sub:!!b.sub,k:b.k,color:b.color?color(b.color,'clay'):null};
  if(k==='ball'){q.c=fx(vec3('clay',b.ball));q.r=+b.r;if(!(q.r>0))bad('clay','ball には r（半径）を書く');q.bc=q.c;q.br=q.r;}
  else if(k==='cap'){const pts=b.cap;if(!Array.isArray(pts)||pts.length<2)bad('clay','cap は [[x,y,z],[x,y,z]] のように点を2つ以上');q.p=pts.map(a=>fx(vec3('clay',a)));
   const rs=Array.isArray(b.r)?b.r:pts.map(()=>b.r);if(rs.length!==pts.length||rs.some(r=>!(r>0)))bad('clay','cap の r は数字1つか、点と同じ数の数字');q.rs=rs.map(Number);
   q.seg=[];for(let i=0;i<q.p.length-1;i++){const a=q.p[i],c=q.p[i+1],ba=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],L2=ba[0]*ba[0]+ba[1]*ba[1]+ba[2]*ba[2]||1e-9;q.seg.push({a,ba,L2,r0:q.rs[i],r1:q.rs[i+1]});}
   let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];q.p.forEach((a,i)=>{for(let d=0;d<3;d++){mn[d]=Math.min(mn[d],a[d]-q.rs[i]);mx[d]=Math.max(mx[d],a[d]+q.rs[i]);}});q.bc=mn.map((v,d)=>(v+mx[d])/2);q.br=Math.hypot(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2])/2;}
  else if(k==='ell'){q.c=fx(vec3('clay',b.ell));q.rr=vec3('clay',b.r);if(q.rr.some(r=>!(r>0)))bad('clay','ell の r は [x半径,y半径,z半径]');q.bc=q.c;q.br=Math.max(...q.rr);}
  else{q.c=fx(vec3('clay',b.rbox));q.h=vec3('clay',b.size).map(v=>v/2);q.r=Math.min(+b.r||0,...q.h);q.bc=q.c;q.br=Math.hypot(...q.h);}
  out.push(q);};
 for(const b of list){if(!b||typeof b!=='object')bad('clay','1つずつ {…} で書く');one(b,false);if(b.pair)one(b,true);}
 if(out.length>120)bad('clay','玉やカプセルは1つの塊に120個まで');return out;}
function clayDist(q,x,y,z){
 if(q.kind==='ball')return Math.hypot(x-q.c[0],y-q.c[1],z-q.c[2])-q.r;
 if(q.kind==='cap'){let best=1e9;for(const s of q.seg){const px=x-s.a[0],py=y-s.a[1],pz=z-s.a[2];let h=(px*s.ba[0]+py*s.ba[1]+pz*s.ba[2])/s.L2;h=h<0?0:h>1?1:h;const d=Math.hypot(px-s.ba[0]*h,py-s.ba[1]*h,pz-s.ba[2]*h)-(s.r0+(s.r1-s.r0)*h);if(d<best)best=d;}return best;}
 if(q.kind==='ell'){const px=(x-q.c[0]),py=(y-q.c[1]),pz=(z-q.c[2]),r=q.rr;const k0=Math.hypot(px/r[0],py/r[1],pz/r[2]),k1=Math.hypot(px/(r[0]*r[0]),py/(r[1]*r[1]),pz/(r[2]*r[2]));return k1>1e-9?k0*(k0-1)/k1:-Math.min(...r);}
 const qx=Math.abs(x-q.c[0])-q.h[0]+q.r,qy=Math.abs(y-q.c[1])-q.h[1]+q.r,qz=Math.abs(z-q.c[2])-q.h[2]+q.r;
 return Math.hypot(Math.max(qx,0),Math.max(qy,0),Math.max(qz,0))+Math.min(Math.max(qx,qy,qz),0)-q.r;}
function claySdf(B,K0,x,y,z){let a=1e9;for(const q of B){const k=q.k??K0;
  if(!q.sub){if(Math.hypot(x-q.bc[0],y-q.bc[1],z-q.bc[2])-q.br>=a+k)continue;const d=clayDist(q,x,y,z);if(k<=0){if(d<a)a=d;continue;}const h=Math.max(k-Math.abs(a-d),0)/k;a=Math.min(a,d)-h*h*k*.25;}
  else{const d=clayDist(q,x,y,z);if(k<=0){a=Math.max(a,-d);continue;}const h=Math.max(k-Math.abs(-d-a),0)/k;a=Math.max(a,-d)+h*h*k*.25;}}
 return a;}
function clayGeo(B,K0,o={}){const t0=performance.now();
 let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9],minR=1e9;
 for(const q of B){if(q.sub)continue;for(let d=0;d<3;d++){mn[d]=Math.min(mn[d],q.bc[d]-q.br);mx[d]=Math.max(mx[d],q.bc[d]+q.br);}minR=Math.min(minR,q.kind==='cap'?Math.min(...q.rs):q.kind==='ell'?Math.min(...q.rr):q.kind==='rbox'?Math.min(...q.h):q.r);}
 if(mn[0]>mx[0])bad('clay','足す形（sub でないもの）が1つもありません');
 const ext=Math.max(mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]);
 // 細かさ：いちばん長い向きを何マスに割るか。細い腕が消えないよう、いちばん細い所の太さが4マス（半径で2マス）になるまで自動で上げる（上限あり）
 let res=Math.round(o.res||Math.min(phone?56:80,Math.max(40,Math.ceil(ext/(minR*.5)))));res=Math.max(16,Math.min(160,res));
 let h=ext/res;const pad=2*h+K0*.25;for(let d=0;d<3;d++){mn[d]-=pad;mx[d]+=pad;}
 let n=[0,1,2].map(d=>Math.ceil((mx[d]-mn[d])/h)+1);
 if(n[0]*n[1]*n[2]>1.2e6){const f=Math.cbrt(1.2e6/(n[0]*n[1]*n[2]));h/=f;n=[0,1,2].map(d=>Math.ceil((mx[d]-mn[d])/h)+1);}
 const [nx,ny,nz]=n,F=new Float32Array(nx*ny*nz),id=(i,j,k)=>i+nx*(j+ny*k);
 // 面から遠い所は細かく調べない：4マスの塊の中心で測り、面が届かないなら塊ごと「中の距離の下限」で埋める
 const BS=4,far=BS*h*.87+h*1.5;for(let bk=0;bk<nz;bk+=BS)for(let bj=0;bj<ny;bj+=BS)for(let bi=0;bi<nx;bi+=BS){const ei=Math.min(bi+BS,nx),ej=Math.min(bj+BS,ny),ek=Math.min(bk+BS,nz),ci=(bi+ei-1)/2,cj=(bj+ej-1)/2,ck=(bk+ek-1)/2;
  const dc=claySdf(B,K0,mn[0]+ci*h,mn[1]+cj*h,mn[2]+ck*h);
  if(Math.abs(dc)>far){const sg=Math.sign(dc),ad=Math.abs(dc);for(let k=bk;k<ek;k++)for(let j=bj;j<ej;j++)for(let i=bi;i<ei;i++)F[id(i,j,k)]=sg*Math.max(h,ad-Math.hypot(i-ci,j-cj,k-ck)*h);}
  else for(let k=bk;k<ek;k++){const z=mn[2]+k*h;for(let j=bj;j<ej;j++){const y=mn[1]+j*h;for(let i=bi;i<ei;i++)F[id(i,j,k)]=claySdf(B,K0,mn[0]+i*h,y,z);}}}
 // マスごとに面の点を1つ置く（符号が変わる辺の交点の平均）
 const cid=new Int32Array((nx-1)*(ny-1)*(nz-1)).fill(-1),cix=(i,j,k)=>i+(nx-1)*(j+(ny-1)*k),P=[];
 const E=[[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]],C=[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]],v=new Float32Array(8);
 for(let k=0;k<nz-1;k++)for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){let neg=0;for(let c=0;c<8;c++){v[c]=F[id(i+C[c][0],j+C[c][1],k+C[c][2])];if(v[c]<0)neg++;}if(neg===0||neg===8)continue;
  let sx=0,sy=0,sz=0,m=0;for(const[a,b]of E){if((v[a]<0)===(v[b]<0))continue;const t=v[a]/(v[a]-v[b]);sx+=C[a][0]+(C[b][0]-C[a][0])*t;sy+=C[a][1]+(C[b][1]-C[a][1])*t;sz+=C[a][2]+(C[b][2]-C[a][2])*t;m++;}
  cid[cix(i,j,k)]=P.length/3;P.push(mn[0]+(i+sx/m)*h,mn[1]+(j+sy/m)*h,mn[2]+(k+sz/m)*h);}
 // 符号が変わる格子の辺ごとに、まわりの4マスの点で四角を張る
 const I=[],quad=(a,b,c,d,flip)=>{if(a<0||b<0||c<0||d<0)return;if(flip){const t=b;b=d;d=t;}
  const dx=(u,w)=>(P[u*3]-P[w*3])**2+(P[u*3+1]-P[w*3+1])**2+(P[u*3+2]-P[w*3+2])**2;if(dx(a,c)<dx(b,d))I.push(a,b,c,a,c,d);else I.push(a,b,d,b,c,d);};
 for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const f0=F[id(i,j,k)]<0;
  if(i<nx-1&&j>0&&k>0&&j<ny-1&&k<nz-1&&(F[id(i+1,j,k)]<0)!==f0)quad(cid[cix(i,j-1,k-1)],cid[cix(i,j,k-1)],cid[cix(i,j,k)],cid[cix(i,j-1,k)],!f0);
  if(j<ny-1&&i>0&&k>0&&i<nx-1&&k<nz-1&&(F[id(i,j+1,k)]<0)!==f0)quad(cid[cix(i-1,j,k-1)],cid[cix(i-1,j,k)],cid[cix(i,j,k)],cid[cix(i,j,k-1)],!f0);
  if(k<nz-1&&i>0&&j>0&&i<nx-1&&j<ny-1&&(F[id(i,j,k+1)]<0)!==f0)quad(cid[cix(i-1,j-1,k)],cid[cix(i,j-1,k)],cid[cix(i,j,k)],cid[cix(i-1,j,k)],!f0);}
 // 点を本当の面の上へ寄せて、法線は場の傾きから取る（角ばらず、つるっとする）
 const nv=P.length/3,N=new Float32Array(nv*3),e=h*.25,f=(x,y,z)=>claySdf(B,K0,x,y,z),iters=o.snap??1;
 for(let s=0;s<nv;s++){let x=P[s*3],y=P[s*3+1],z=P[s*3+2],gx=0,gy=0,gz=0;
  for(let it=0;it<=iters;it++){const d=f(x,y,z);gx=f(x+e,y,z)-d;gy=f(x,y+e,z)-d;gz=f(x,y,z+e)-d;const g2=(gx*gx+gy*gy+gz*gz)/(e*e);
   if(it<iters&&g2>1e-6){const st=Math.max(-h*.6,Math.min(h*.6,d/g2))/e;x-=gx*st;y-=gy*st;z-=gz*st;}}
  const L=Math.hypot(gx,gy,gz)||1;P[s*3]=x;P[s*3+1]=y;P[s*3+2]=z;N[s*3]=gx/L;N[s*3+1]=gy/L;N[s*3+2]=gz/L;}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('normal',new THREE.BufferAttribute(N,3));g.setIndex(I);
 g.computeBoundingSphere();g.computeBoundingBox();
 const ms=performance.now()-t0;g.userData.clay={ms:Math.round(ms*10)/10,res,cells:nx*ny*nz,verts:nv,tris:I.length/3,blobs:B.length};return g;}
const CLAY_MAT={color:'#e9e6df',roughness:.48,metalness:0,envMapIntensity:.75};
// 色ごとに別の塊にする（同じ色どうしはなめらかにくっつき、色の境目は形の交わりでくっきり分かれる）。
// 小さい部品は小さい箱で調べるので、細かく作られる。
function clay(list,mat,o={}){if(mat&&!mat.isMaterial&&typeof mat==='object'&&!Array.isArray(mat)){o=mat;mat=null;}
 const t0=performance.now(),B=clayBlobs(list),K0=Math.max(0,o.smooth??.06),base=mat||std(CLAY_MAT),subs=B.filter(q=>q.sub&&!q.color),G=new Map();
 for(const q of B){if(q.sub&&!q.color)continue;const key=q.color?'#'+q.color.getHexString():'';if(!G.has(key))G.set(key,[]);G.get(key).push(q);}
 const parts=[];for(const[key,bs]of G){if(!bs.some(q=>!q.sub))continue;const g=clayGeo([...bs,...subs],K0,o);let m=base;if(key){m=cloneMat(base);if(m.color)m.color.set(key);}parts.push({g,m,key});}
 if(!parts.length)bad('clay','足す形（sub でないもの）が1つもありません');
 const st={ms:0,res:[],cells:0,verts:0,tris:0,blobs:B.length,parts:parts.length};
 for(const{g}of parts){const c=g.userData.clay;st.res.push(c.res);st.cells+=c.cells;st.verts+=c.verts;st.tris+=c.tris;}
 let r;if(parts.length===1)r=mesh(parts[0].g,parts[0].m,o,'clay');
 else{r=group({at:o.at,rot:o.rot,scale:o.scale,name:o.name,parent:o.parent});for(const{g,m,key}of parts){const x=mesh(g,m,{parent:r,shadow:o.shadow,name:key?o.name:undefined},'clay');if(o.name)x.name=String(o.name);}}
 st.ms=Math.round((performance.now()-t0)*10)/10;r.userData.clay=st;return r;}

// 光のにじみ（窓・ライト・見えない物の目印）
const softSprite=(c,op)=>new THREE.SpriteMaterial({map:softTex,color:new THREE.Color(c),transparent:true,opacity:op,depthWrite:false,blending:THREE.AdditiveBlending,fog:false,toneMapped:false});
function glow(at,size=.6,c='#ffc98a',op=.6,o={}){const s=noRay(new THREE.Sprite(softSprite(c,op)));s.scale.setScalar(size);s.userData.fx=true;s.renderOrder=6;place(s,{at,parent:o.parent},'glow');return{obj:s,set(a){s.material.opacity=op*clamp(a);s.visible=a>.01;return this;}};}
// 物の足元の影（物が床に立って見える）
const blobTex=tex(128,(g,s)=>{const r=g.createRadialGradient(s/2,s/2,s*.1,s/2,s/2,s/2);r.addColorStop(0,'rgba(0,0,0,1)');r.addColorStop(.55,'rgba(0,0,0,.72)');r.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=r;g.fillRect(0,0,s,s);});
function blob(at,rx,rz,op=.5,o={}){const m=new THREE.Mesh(new THREE.PlaneGeometry(rx*2,rz*2),new THREE.MeshBasicMaterial({map:blobTex,transparent:true,opacity:op,depthWrite:false,color:0x000000}));m.rotation.x=-Math.PI/2;m.position.set(...vec3('blob',at));m.renderOrder=1;m.userData.fx=true;noRay(m);(o.parent||scene).add(m);return m;}

// ===== 面の種類を足す =====
Object.assign(SURF,{
 snow:{c:'#e4ebf7',s:.28,b:.022,r:.8,d(g,s){g.fillStyle='#ececec';g.fillRect(0,0,s,s);for(let i=0;i<Math.round(s*.34);i++){const r=rnd(s*.02,s*.12),v=rand()>.5?255:205,x0=rnd(s),y0=rnd(s);for(const dx of[-s,0,s])for(const dy of[-s,0,s]){const x=x0+dx,y=y0+dy;if(x+r<0||x-r>s||y+r<0||y-r>s)continue;const q=g.createRadialGradient(x,y,0,x,y,r);q.addColorStop(0,`rgba(${v},${v},${v},.13)`);q.addColorStop(1,`rgba(${v},${v},${v},0)`);g.fillStyle=q;g.fillRect(x-r,y-r,r*2,r*2);}}}},
 grass:{c:'#5d7a3e',s:1.2,b:.05,r:.96,d(g,s){speckle(g,s,'#c4c4c4',['#8e8e8e','#efefef','#a9a9a9'],Math.round(s*s*.04),1.8);g.lineCap='round';for(let i=0;i<Math.round(s*2.6);i++){g.globalAlpha=rnd(.12,.34);g.strokeStyle=i%2?'#f2f2f2':'#7a7a7a';g.lineWidth=rnd(.5,1.5);const x=rnd(s),y=rnd(s);g.beginPath();g.moveTo(x,y);g.lineTo(x+rnd(-5,5),y-rnd(5,18));g.stroke();}g.globalAlpha=1;}},
 tatami:{c:'#b5ab78',s:1.4,b:.012,r:.92,d(g,s){g.fillStyle='#d8d8d8';g.fillRect(0,0,s,s);const st=s/170;for(let i=0;i<170;i++){g.globalAlpha=rnd(.12,.3);g.fillStyle=i%2?'#f6f6f6':'#9b9b9b';g.fillRect(0,i*st,s,st*.55);}g.globalAlpha=1;}},
 planks:{c:'#9b744c',s:.42,b:.02,r:.72,d(g,s){const n=8,ph=s/n;for(let i=0;i<n;i++){const v=Math.floor(rnd(170,235));g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(0,i*ph,s,ph);g.lineCap='round';for(let k=0;k<80;k++){g.globalAlpha=rnd(.04,.16);g.strokeStyle=k%2?'#ffffff':'#6b6b6b';g.lineWidth=rnd(.4,1.5);const y=i*ph+rnd(ph);g.beginPath();g.moveTo(rnd(-40,s),y);g.lineTo(rnd(0,s+40),y+rnd(-2,2));g.stroke();}g.globalAlpha=.7;g.fillStyle='#3c3c3c';g.fillRect(0,i*ph,s,1.6);const x=rnd(s);g.fillRect(x,i*ph,1.6,ph);g.globalAlpha=1;}}},
});

// ===== 空と映り込み =====
const SKYF=`varying vec3 vD;uniform vec3 uA,uB,uC,uD,uCl;uniform float uStars,uCloud,uDim;${NOISE}
void main(){vec3 d=normalize(vD);float h=max(d.y,0.);vec3 c=mix(uA,uB,smoothstep(0.,.07,h));c=mix(c,uC,smoothstep(.05,.3,h));c=mix(c,uD,smoothstep(.22,.82,h));
 if(uCloud>0.){vec2 q=d.xz/(d.y+.16);float f=fb(vec3(q*1.15,2.1));f=smoothstep(.48,.76,f)*smoothstep(.015,.14,h);c=mix(c,uCl,f*uCloud);}
 if(uStars>0.){vec3 q=floor(d*170.);float s=hh(q);c+=vec3(1.,.97,.9)*step(.9972,s)*uStars*smoothstep(.12,.42,h)*(.35+.65*hh(q+3.));}
 c*=uDim;float dn=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);gl_FragColor=vec4(c+(dn-.5)/240.,1.);
 #include <colorspace_fragment>
}`;
function skyMat(s){return new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,fog:false,toneMapped:false,
 uniforms:{uA:{value:new THREE.Color(s.a)},uB:{value:new THREE.Color(s.b)},uC:{value:new THREE.Color(s.c)},uD:{value:new THREE.Color(s.d)},uCl:{value:new THREE.Color(s.cl||'#ffffff')},uStars:{value:s.stars||0},uCloud:{value:s.cloud||0},uDim:{value:1}},
 vertexShader:'varying vec3 vD;void main(){vD=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:SKYF});}
function makeSky(s){const m=skyMat(s),d=noRay(new THREE.Mesh(new THREE.SphereGeometry(120,32,20),m));d.userData.fx=true;d.userData.backdrop=true;d.renderOrder=-10;scene.add(d);return{dome:d,mat:m};}
function envFrom(build){const env=new THREE.Scene();build(env);const pm=new THREE.PMREMGenerator(renderer);scene.environment=pm.fromScene(env,.03).texture;pm.dispose();}
function strip(env,x,y,z,sx,sy,col,power){const m=new THREE.Mesh(new THREE.PlaneGeometry(sx,sy),new THREE.MeshBasicMaterial({color:new THREE.Color(col).multiplyScalar(power),side:THREE.DoubleSide}));m.position.set(x,y,z);m.lookAt(0,0,0);env.add(m);}
function skyEnv(s,floor,strips){envFrom(env=>{env.add(new THREE.Mesh(new THREE.SphereGeometry(50,24,16),skyMat(s)));const f=new THREE.Mesh(new THREE.CircleGeometry(50,24),new THREE.MeshBasicMaterial({color:new THREE.Color(floor)}));f.rotation.x=-Math.PI/2;f.position.y=-2;env.add(f);for(const a of strips)strip(env,...a);});}
function roomEnv(wallC,floorC,ceilC,strips){envFrom(env=>{const r=new THREE.Mesh(new THREE.BoxGeometry(40,16,40),[wallC,wallC,ceilC,floorC,wallC,wallC].map(c=>new THREE.MeshBasicMaterial({color:new THREE.Color(c),side:THREE.BackSide})));r.position.y=6;env.add(r);for(const a of strips)strip(env,...a);});}

// ===== 背景の飾り（どれも backdrop。検査でカメラをふさいだ扱いにしない）=====
function vcolor(g,c){const col=new THREE.Color(c),n=g.attributes.position.count,a=new Float32Array(n*3);for(let i=0;i<n;i++){a[i*3]=col.r;a[i*3+1]=col.g;a[i*3+2]=col.b;}g.setAttribute('color',new THREE.BufferAttribute(a,3));return g;}
function mergeC(list){const parts=list.map(g=>{const q=g.index?g.toNonIndexed():g;q.computeVertexNormals();return q;});return mergeGeometries(parts,false);}
function coniferGeo(snow){const L=[],leaf=snow?'#1c3a38':'#27503c',cap='#eef3fb';const T=[[1.25,1.5,1.3],[1.02,1.35,2.15],[.78,1.2,2.95],[.5,1.0,3.65]];
 L.push(vcolor(new THREE.CylinderGeometry(.13,.18,1.1,8).translate(0,.5,0),'#3c2c22'));
 for(const[r,h,y]of T){L.push(vcolor(new THREE.ConeGeometry(r,h,9,1).translate(0,y,0),leaf));if(snow)L.push(vcolor(new THREE.ConeGeometry(r*.74,h*.66,9,1).translate(0,y+h*.2,0),cap));}return mergeC(L);}
function roundTreeGeo(){const L=[vcolor(new THREE.CylinderGeometry(.12,.17,1.3,8).translate(0,.6,0),'#4a3626')];for(const[x,y,z,r,c]of[[0,1.9,0,1.05,'#3f6b34'],[.6,1.55,.2,.72,'#4a7a3b'],[-.55,1.6,-.25,.78,'#37602f'],[.1,2.5,-.1,.7,'#54873f']])L.push(vcolor(new THREE.IcosahedronGeometry(r,1).translate(x,y,z),c));return mergeC(L);}
function scatter(geo,n,r0,r1,o={}){const m=noRay(new THREE.InstancedMesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,flatShading:true,roughness:.92,envMapIntensity:.25}),n));const q=new THREE.Object3D(),col=new THREE.Color();let k=0,tries=0;
 while(k<n&&tries++<n*40){const a=rnd(6.283),r=rnd(r0,r1),x=Math.cos(a)*r,z=Math.sin(a)*r+(o.dz||0);if(o.keep&&!o.keep(x,z))continue;const s=rnd(o.s0||.8,o.s1||1.5);q.position.set(x,0,z);q.rotation.y=rnd(6.283);q.scale.set(s,s*rnd(.9,1.25),s);q.updateMatrix();m.setMatrixAt(k,q.matrix);const v=rnd(.78,1.08);col.setRGB(v,v,v);m.setColorAt(k,col);k++;}
 m.count=k;m.userData.backdrop=true;m.castShadow=false;m.receiveShadow=false;scene.add(m);return m;}
function miniHouse(x,z,w,d,h,ry,o={}){const g=new THREE.Group();g.position.set(x,0,z);g.rotation.y=ry;g.userData.backdrop=true;scene.add(g);
 const wallM=std({color:o.wall||'#6f7480',roughness:.9,envMapIntensity:.3}),roofM=std({color:o.roof||'#3b4150',roughness:.8,envMapIntensity:.35});
 const body=noRay(new THREE.Mesh(new THREE.BoxGeometry(w,h,d),wallM));body.position.y=h/2;g.add(body);
 const rh=o.rh||w*.28,sh=new THREE.Shape([[-w/2-.35,0],[0,rh],[w/2+.35,0]].map(a=>new THREE.Vector2(a[0],a[1]))),rg=new THREE.ExtrudeGeometry(sh,{depth:d+.6,bevelEnabled:false});
 const roof=noRay(new THREE.Mesh(rg,roofM));roof.position.set(0,h,-d/2-.3);g.add(roof);
 if(o.snow){const snM=std({color:'#eaf0fa',roughness:.9,envMapIntensity:.3}),sg=new THREE.ExtrudeGeometry(new THREE.Shape([[-w/2-.42,-.02],[0,rh+.02],[w/2+.42,-.02],[w/2+.3,.02],[0,rh+.24],[-w/2-.3,.02]].map(a=>new THREE.Vector2(a[0],a[1]))),{depth:d+.66,bevelEnabled:false}),sn=noRay(new THREE.Mesh(sg,snM));sn.position.set(0,h,-d/2-.33);g.add(sn);}
 const n=o.windows??2;for(let i=0;i<n;i++){const wx=(i-(n-1)/2)*w/(n+.5),lit=o.lit===undefined?rand()>.3:o.lit,c=lit?(o.glow||'#ffcf8e'):'#2b3442',pane=noRay(new THREE.Mesh(new THREE.PlaneGeometry(.72,.92),new THREE.MeshBasicMaterial({color:new THREE.Color(c).multiplyScalar(lit?1.1:1),toneMapped:!lit,fog:!lit})));pane.position.set(wx,h*.56,d/2+.01);g.add(pane);
  const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(.05,.96,.03),std({color:'#22262e'})));fr.position.set(wx,h*.56,d/2+.02);g.add(fr);const fh=noRay(new THREE.Mesh(new THREE.BoxGeometry(.76,.05,.03),std({color:'#22262e'})));fh.position.set(wx,h*.56,d/2+.02);g.add(fh);
  if(lit){const gl=noRay(new THREE.Sprite(softSprite(c,.28)));gl.scale.setScalar(2.2);gl.position.set(wx,h*.56,d/2+.2);gl.userData.fx=true;g.add(gl);}}
 return g;}
function streetLamp(x,z,o={}){const c=o.c||'#ffc98a',h=o.h||5,M=std({color:'#23262c',roughness:.55,metalness:.4});const gp=new THREE.Group();gp.position.set(x,0,z);gp.userData.backdrop=true;scene.add(gp);
 const pole=noRay(new THREE.Mesh(new THREE.CylinderGeometry(.05,.075,h,12),M));pole.position.y=h/2;gp.add(pole);const armL=o.arm||.9,arm=noRay(new THREE.Mesh(new THREE.BoxGeometry(armL,.05,.05),M));arm.position.set(armL/2,h-.02,0);gp.add(arm);
 const lampH=noRay(new THREE.Mesh(new THREE.BoxGeometry(.4,.07,.2),M));lampH.position.set(armL,h-.05,0);gp.add(lampH);const em=noRay(new THREE.Mesh(new THREE.PlaneGeometry(.34,.14),new THREE.MeshBasicMaterial({color:new THREE.Color(c).multiplyScalar(1.3),toneMapped:false,side:THREE.DoubleSide,fog:false})));em.rotation.x=Math.PI/2;em.position.set(armL,h-.09,0);gp.add(em);
 const gl=noRay(new THREE.Sprite(softSprite(c,.75)));gl.scale.setScalar(1.8);gl.position.set(armL,h-.14,0);gl.userData.fx=true;gp.add(gl);
 if(o.light!==false){const sp=new THREE.SpotLight(c,o.power||46,h*3.2,.8,.75,1.4);sp.position.set(x+armL,h-.1,z);sp.target.position.set(x+armL*.5,0,z+(o.tz||1.5));scene.add(sp,sp.target);return{group:gp,light:sp};}return{group:gp};}
function snowfall(n=220){const c=Math.round(n*FX_OK),pos=new Float32Array(c*3),sd=new Float32Array(c);for(let i=0;i<c;i++){pos[i*3]=rnd(-16,16);pos[i*3+1]=rnd(9);pos[i*3+2]=rnd(-12,14);sd[i]=rand();}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('aS',new THREE.BufferAttribute(sd,1));
 const m=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uT:timeU,uPx:pxU,uA:{value:.7}},vertexShader:'attribute float aS;uniform float uT,uPx;varying float vS;void main(){vec3 p=position;vS=aS;p.y=mod(p.y-uT*(.3+aS*.4),9.);p.x+=sin(uT*.35+aS*40.)*.4;p.z+=cos(uT*.28+aS*31.)*.3;vec4 mv=viewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=min(uPx*(9.+aS*16.)/max(.3,-mv.z),9.);}',
  fragmentShader:'varying float vS;uniform float uA;void main(){float d=length(gl_PointCoord-.5)*2.;float a=smoothstep(1.,.2,d);gl_FragColor=vec4(vec3(1.),a*uA*(.35+.5*vS));}'});
 const pts=noRay(new THREE.Points(g,m));pts.frustumCulled=false;pts.renderOrder=8;pts.userData.fx=true;scene.add(pts);return{obj:pts,set(a){m.uniforms.uA.value=.7*clamp(a);pts.visible=a>.01;return this;}};}
// カメラのあとで毎回：天井より上から見たら天井の灯りを消す／もやを上から見ても見えるようにする
let roofTop=0,roofList=null;const afterCamFx=[];
function afterCam(){if(roofTop){if(!roofList)roofList=scene.children.filter(o=>(o.userData.backdrop||o.userData.fx)&&o.position.y>=roofTop*.8&&o.position.y<=roofTop+.5);const v=camera.position.y<roofTop-.05;for(const o of roofList)o.visible=v;}for(const f of afterCamFx)f();}
function roomShell(o){const wid=o.w||16,dep=o.d||14,hei=o.h||4.4,cz=o.cz||0;roofTop=hei;roofList=null;const S=[];const add=(w,h,mat,at,rot,name)=>{const m=plane(w,h,mat,{at,rot,name,backdrop:true});m.castShadow=false;m.receiveShadow=true;S.push(m);return m;};
 add(wid,hei,o.back,[0,hei/2,cz-dep/2],[0,0,0],'奥の壁');add(wid,hei,o.front||o.back,[0,hei/2,cz+dep/2],[0,Math.PI,0],'手前の壁');add(dep,hei,o.side||o.back,[-wid/2,hei/2,cz],[0,Math.PI/2,0],'横の壁');add(dep,hei,o.side||o.back,[wid/2,hei/2,cz],[0,-Math.PI/2,0],'横の壁');
 const ce=plane(wid,dep,o.ceil,{at:[0,hei,cz],rot:[Math.PI/2,0,0],name:'天井',backdrop:true});ce.castShadow=false;return{wid,dep,hei,cz,back:cz-dep/2};}
function stripesTex(base,dark,n=40,vertical=true){return tex(512,(g,s)=>{g.fillStyle=base;g.fillRect(0,0,s,s);const st=s/n;for(let i=0;i<n;i++){g.fillStyle=dark;g.globalAlpha=.55;if(vertical)g.fillRect(i*st,0,st*.22,s);else g.fillRect(0,i*st,s,st*.22);g.globalAlpha=.12;g.fillStyle='#fff';if(vertical)g.fillRect(i*st+st*.5,0,st*.1,s);else g.fillRect(0,i*st+st*.5,s,st*.1);}g.globalAlpha=1;});}
function setLights(q){const a=[];for(const l of q)if(l){scene.add(l);if(l.target)scene.add(l.target);a.push({l,i:l.intensity});}lightDone=true;return a;}
function shadowKey(k,sz){k.castShadow=true;const ms=phone?1024:2048;k.shadow.mapSize.set(ms,ms);if(k.isDirectionalLight)Object.assign(k.shadow.camera,{left:-sz,right:sz,top:sz,bottom:-sz,near:.5,far:sz*5});else{k.shadow.camera.near=1;k.shadow.camera.far=sz*5;}k.shadow.bias=-.0004;k.shadow.normalBias=.02;return k;}
const dirL=(c,i,x,y,z)=>{const d=new THREE.DirectionalLight(c,i);d.position.set(x,y,z);return d;};

// ===== 世界：その仕事らしい場所 =====
const WORLDS={
 snow_night(o){const s={a:'#e0926a',b:'#a2707c',c:'#3a4a78',d:'#0b1430',stars:.9};const sk=makeSky(s);skyEnv(s,'#6f7b96',[[-8,16,10,34,2.4,'#dfe7ff',7],[10,12,-12,22,3,'#ffd9b0',4.5],[0,6,24,40,1,'#ffe6c8',2.2]]);
  scene.background=new THREE.Color('#0b1430');scene.fog=new THREE.FogExp2(new THREE.Color('#33415f'),.026);ground('snow',{size:90,color:'#dbe3f2',name:'雪の地面'});
  const lights=setLights([new THREE.HemisphereLight('#9fb6e6','#c7d2e6',.82),shadowKey(dirL('#cfdcff',1.5,-5,9,6.5),o.size||8)]);
  const keep=(x,z)=>!(Math.abs(x)<o.clear&&z>-o.clear*.55);scatter(coniferGeo(true),o.trees??38,8,34,{keep,dz:-6,s0:.9,s1:1.8});
  const bank=std({color:'#dfe6f4',roughness:.92,envMapIntensity:.3});for(let i=0;i<9;i++){const a=rnd(-2.6,-.5),r=rnd(o.clear+2,o.clear+8),b=noRay(new THREE.Mesh(new THREE.SphereGeometry(1,20,12),bank));b.scale.set(rnd(1.4,3.6),rnd(.22,.6),rnd(1,2));b.position.set(Math.cos(a)*r,0,Math.sin(a)*r);b.userData.backdrop=true;b.receiveShadow=true;scene.add(b);}
  miniHouse(-7.5,-9.5,5.2,4,2.8,.28,{snow:true,lit:true,windows:2});miniHouse(8.5,-11,6,4.4,3,-.3,{snow:true,lit:true,windows:3,wall:'#5f6a7d'});miniHouse(-1,-16,5,4,2.6,.05,{snow:true,windows:2,wall:'#677182'});
  const lamp=streetLamp(-5.2,-3.2,{power:64,tz:3.4,arm:1});const fall=snowfall(o.snow??220);return{sky:sk,lights:[...lights,{l:lamp.light,i:lamp.light.intensity}],snow:fall};},
 garage(o){const wall=stripesTex('#9aa1a8','#5d646c',44);wall.repeat.set(4,1);const lower=std({color:'#3c4753',roughness:.72});const mid=std({map:wall,color:'#ffffff',roughness:.62,metalness:.25,envMapIntensity:.55});
  roomEnv('#7a828a','#4a4d52','#2a2d33',[[0,9,0,22,2,'#ffffff',11],[-9,8,6,14,1.3,'#ffffff',8],[9,8,-6,14,1.3,'#eaf2ff',8],[14,4,8,10,3,'#ffd8b0',2.2]]);scene.background=new THREE.Color('#14171b');
  const R=roomShell({w:o.w||18,d:o.d||15,h:4.6,cz:o.cz||0,back:mid,ceil:std({color:'#2f3338',roughness:.8})});
  const fl=surface('concrete',{color:o.floor||'#7a7d80',rough:.46,env:.75,scale:.9});const f=plane(40,40,fl,{rot:[-Math.PI/2,0,0],name:'床',backdrop:true});f.castShadow=false;
  const lines=emitless('#d9b23a');for(const x of[-3.4,3.4]){const l=noRay(new THREE.Mesh(new THREE.PlaneGeometry(.11,8.6),lines));l.rotation.x=-Math.PI/2;l.position.set(x,.004,.4);l.userData.backdrop=true;scene.add(l);}
  const bz=R.back;const lo=noRay(new THREE.Mesh(new THREE.BoxGeometry(R.wid,1.05,.06),lower));lo.position.set(0,.52,bz+.04);lo.userData.backdrop=true;lo.receiveShadow=true;scene.add(lo);
  for(let i=0;i<5;i++){const x=(i-2)*3.6,col=noRay(new THREE.Mesh(new THREE.BoxGeometry(.26,4.6,.26),std({color:'#454c54',roughness:.5,metalness:.5})));col.position.set(x,2.3,bz+.14);col.userData.backdrop=true;col.receiveShadow=true;scene.add(col);
   const haz=noRay(new THREE.Mesh(new THREE.BoxGeometry(.28,.7,.28),std({map:tex(128,(g,s)=>{g.fillStyle='#e0b72e';g.fillRect(0,0,s,s);g.fillStyle='#1b1b1b';for(let k=-s;k<s*2;k+=44){g.beginPath();g.moveTo(k,0);g.lineTo(k+22,0);g.lineTo(k+22-s,s);g.lineTo(k-s,s);g.fill();}}),roughness:.6})));haz.position.set(x,.35,bz+.14);haz.userData.backdrop=true;scene.add(haz);}
  // 高い窓：外の夕方が少し見える
  const pane=new THREE.MeshBasicMaterial({map:tex(64,(g,s)=>{const q=g.createLinearGradient(0,s,0,0);q.addColorStop(0,'#f0a877');q.addColorStop(.5,'#8d7fa6');q.addColorStop(1,'#39507f');g.fillStyle=q;g.fillRect(0,0,s,s);}),toneMapped:false,fog:false});
  for(let i=0;i<4;i++){const x=(i-1.5)*3.6,p=noRay(new THREE.Mesh(new THREE.PlaneGeometry(2.6,.78),pane));p.position.set(x,3.5,bz+.06);p.userData.backdrop=true;scene.add(p);for(const q of[-.65,.65,0]){const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(.04,.82,.03),std({color:'#23272c'})));fr.position.set(x+q*1.0,3.5,bz+.08);fr.userData.backdrop=true;scene.add(fr);}const gl=noRay(new THREE.Sprite(softSprite('#f3b48a',.16)));gl.scale.setScalar(3.4);gl.position.set(x,3.5,bz+.3);gl.userData.fx=true;scene.add(gl);}
  // 棚（荷物だけ。道具は置かない）
  const shelfM=std({color:'#2d3238',roughness:.5,metalness:.55}),boxM=[std({color:'#a58a63',roughness:.9}),std({color:'#8e7654',roughness:.9}),std({color:'#b79c74',roughness:.9})];
  for(const sx of[-7.4,7.2]){for(const dx of[-1.55,1.55]){const up=noRay(new THREE.Mesh(new THREE.BoxGeometry(.07,2.5,.5),shelfM));up.position.set(sx+dx,1.25,bz+.58);up.userData.backdrop=true;scene.add(up);}for(const y of[.5,1.25,2.0]){const sh=noRay(new THREE.Mesh(new THREE.BoxGeometry(3.2,.05,.6),shelfM));sh.position.set(sx,y,bz+.58);sh.userData.backdrop=true;sh.receiveShadow=true;scene.add(sh);let x=-1.35;while(x<1.2){const w=rnd(.42,.8),h=rnd(.26,.5);if(rand()>.2){const b=noRay(new THREE.Mesh(new THREE.BoxGeometry(w,h,.42),boxM[Math.floor(rnd(3))]));b.position.set(sx+x+w/2,y+.025+h/2,bz+.58);b.userData.backdrop=true;b.castShadow=true;scene.add(b);}x+=w+.08;}}}
  // 天井の灯り
  const led=new THREE.MeshBasicMaterial({color:new THREE.Color('#f4f8ff').multiplyScalar(1.5),toneMapped:false,side:THREE.DoubleSide,fog:false});for(const x of[-4.4,0,4.4])for(const z of[-3.4,2.2]){const l=noRay(new THREE.Mesh(new THREE.PlaneGeometry(2.8,.16),led));l.rotation.x=Math.PI/2;l.position.set(x,4.55,z);l.userData.backdrop=true;scene.add(l);const gl=noRay(new THREE.Sprite(softSprite('#eaf2ff',.3)));gl.scale.set(4.2,1.1,1);gl.position.set(x,4.45,z);gl.userData.fx=true;scene.add(gl);}
  const lights=setLights([new THREE.HemisphereLight('#eef3fa','#5a5d62',.95),shadowKey(dirL('#fff6ea',1.7,2.5,8,4),o.size||8),dirL('#bcd2ee',.5,-6,5,-3)]);return{lights};},
 workshop(o){const boards=stripesTex('#b18d63','#6b4c30',14);boards.repeat.set(3,1);const wallM=std({map:boards,color:'#ffffff',roughness:.8,envMapIntensity:.4});
  roomEnv('#8a6f55','#55422f','#3a2c20',[[0,9,0,18,2,'#fff1dc',6],[12,5,4,6,6,'#ffe2b8',7],[-9,6,4,10,1,'#ffd9b0',3]]);scene.background=new THREE.Color('#1a130d');
  const R=roomShell({w:o.w||16,d:o.d||13,h:4.2,cz:o.cz||0,back:wallM,ceil:std({color:'#4a3726',roughness:.9})});
  const fl=plane(40,40,surface(o.floor||'planks',{color:o.floorColor}),{rot:[-Math.PI/2,0,0],name:'床',backdrop:true});fl.castShadow=false;
  const bz=R.back,beamM=wood({base:'#6b4a2e',late:'#4a311d',rings:10,scale:.8});for(let i=0;i<5;i++){const b=noRay(new THREE.Mesh(new THREE.BoxGeometry(R.wid,.26,.26),beamM));b.position.set(0,3.98,bz+1.6+i*2.6);b.userData.backdrop=true;scene.add(b);}
  // 窓と差し込む光
  const paneM=new THREE.MeshBasicMaterial({map:tex(64,(g,s)=>{const q=g.createLinearGradient(0,s,0,0);q.addColorStop(0,'#ffe7b8');q.addColorStop(1,'#cfe6ff');g.fillStyle=q;g.fillRect(0,0,s,s);}),toneMapped:false,fog:false});const wx=o.windowX??3.8;
  const p=noRay(new THREE.Mesh(new THREE.PlaneGeometry(3.2,1.7),paneM));p.position.set(wx,2.45,bz+.05);p.userData.backdrop=true;scene.add(p);const frM=wood({base:'#4e3522',late:'#35230f',rings:8,scale:2});for(const dx of[-1.6,-.53,.53,1.6]){const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(.07,1.76,.08),frM));fr.position.set(wx+dx,2.45,bz+.08);fr.userData.backdrop=true;scene.add(fr);}for(const dy of[-.86,0,.86]){const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(3.26,.07,.08),frM));fr.position.set(wx,2.45+dy,bz+.08);fr.userData.backdrop=true;scene.add(fr);}
  const gl=noRay(new THREE.Sprite(softSprite('#ffe2b4',.26)));gl.scale.set(6.4,3.8,1);gl.position.set(wx,2.45,bz+.3);gl.userData.fx=true;scene.add(gl);
  // 作業台の棚（道具は置かない）
  const benchM=wood({base:'#94704a',late:'#6d4f30',rings:16,scale:1.2}),bx=-4;const top=noRay(new THREE.Mesh(new THREE.BoxGeometry(5.4,.1,.8),benchM));top.position.set(bx,.92,bz+.52);top.userData.backdrop=true;top.castShadow=true;scene.add(top);for(const dx of[-2.5,2.5]){const lg=noRay(new THREE.Mesh(new THREE.BoxGeometry(.1,.9,.7),benchM));lg.position.set(bx+dx,.45,bz+.52);lg.userData.backdrop=true;scene.add(lg);}for(const y of[2.0,2.75]){const sh=noRay(new THREE.Mesh(new THREE.BoxGeometry(4.6,.06,.34),benchM));sh.position.set(bx,y,bz+.2);sh.userData.backdrop=true;sh.castShadow=true;scene.add(sh);}
  // 吊り下げの灯り
  const shade=std({color:'#25282c',roughness:.55,metalness:.4}),warm=new THREE.MeshBasicMaterial({color:new THREE.Color('#ffd9a0').multiplyScalar(1.3),toneMapped:false,fog:false});for(const x of[-3.2,1.2]){const c=noRay(new THREE.Mesh(new THREE.CylinderGeometry(.008,.008,.9,6),shade));c.position.set(x,3.75,.6);c.userData.backdrop=true;scene.add(c);const s=noRay(new THREE.Mesh(new THREE.ConeGeometry(.28,.2,24,1,true),shade));s.material.side=THREE.DoubleSide;s.position.set(x,3.22,.6);s.userData.backdrop=true;scene.add(s);const b=noRay(new THREE.Mesh(new THREE.SphereGeometry(.07,12,8),warm));b.position.set(x,3.16,.6);b.userData.backdrop=true;scene.add(b);const g2=noRay(new THREE.Sprite(softSprite('#ffc98a',.5)));g2.scale.setScalar(1.4);g2.position.set(x,3.14,.6);g2.userData.fx=true;scene.add(g2);}
  const sp=new THREE.SpotLight('#ffe0b4',38,14,.95,.8,1.2);sp.position.set(.5,3.9,1.2);sp.target.position.set(0,0,.2);
  const lights=setLights([new THREE.HemisphereLight('#ffeedd','#3d2c20',.8),shadowKey(sp,o.size||8),dirL('#ffe6c4',1.0,5,4,-3),dirL('#9fc0e6',.28,-6,3,3)]);return{lights};},
 room(o){const j=!!o.japanese,wc=o.wall||(j?'#cfc6ae':'#d6d2c8');const wallM=surface('plaster',{color:wc,scale:.5});
  roomEnv(wc,'#6f5a42','#e8e4da',[[0,8,0,6,6,'#ffffff',6],[0,4,-16,12,5,'#ffffff',8]]);scene.background=new THREE.Color('#25221d');
  const R=roomShell({w:o.w||12,d:o.d||11,h:2.9,cz:o.cz||0,back:wallM,ceil:std({color:'#ece8df',roughness:.9})});
  const f=plane(30,30,surface(o.floor||(j?'tatami':'planks'),{color:o.floorColor}),{rot:[-Math.PI/2,0,0],name:'床',backdrop:true});f.castShadow=false;
  if(j&&!o.floor){const heri=new THREE.MeshStandardMaterial({color:'#39462f',roughness:.8,polygonOffset:true,polygonOffsetFactor:-2});for(let i=-5;i<=5;i++){const l=noRay(new THREE.Mesh(new THREE.PlaneGeometry(.045,R.dep),heri));l.rotation.x=-Math.PI/2;l.position.set(i*1.8,.003,R.cz);l.userData.backdrop=true;scene.add(l);}for(let i=-5;i<=5;i++){const l=noRay(new THREE.Mesh(new THREE.PlaneGeometry(R.wid,.045),heri));l.rotation.x=-Math.PI/2;l.position.set(0,.003,R.cz+i*.9*2);l.userData.backdrop=true;scene.add(l);}}
  const bz=R.back,base=wood({base:'#7f5e3e',late:'#5b4029',rings:12,scale:1.5});for(const[w,x,z,ry]of[[R.wid,0,bz+.03,0],[R.dep,-R.wid/2+.03,R.cz,Math.PI/2],[R.dep,R.wid/2-.03,R.cz,-Math.PI/2]]){const b=noRay(new THREE.Mesh(new THREE.BoxGeometry(w,.09,.03),base));b.position.set(x,.045,z);b.rotation.y=ry;b.userData.backdrop=true;scene.add(b);}
  const wx=o.windowX??1.8,pM=j?new THREE.MeshBasicMaterial({map:tex(256,(g,s)=>{g.fillStyle='#fbf6e8';g.fillRect(0,0,s,s);g.fillStyle='#5a4230';for(let i=0;i<=4;i++)g.fillRect(i*s/4-2,0,4,s);for(let i=0;i<=5;i++)g.fillRect(0,i*s/5-2,s,4);}),toneMapped:false,fog:false}):new THREE.MeshBasicMaterial({map:tex(64,(g,s)=>{const q=g.createLinearGradient(0,s,0,0);q.addColorStop(0,'#e7f0e0');q.addColorStop(.6,'#cfe3f5');q.addColorStop(1,'#a7cdf0');g.fillStyle=q;g.fillRect(0,0,s,s);}),toneMapped:false,fog:false});
  const pn=noRay(new THREE.Mesh(new THREE.PlaneGeometry(j?3.4:3,j?1.9:1.5),pM));pn.position.set(wx,j?1.15:1.55,bz+.04);pn.userData.backdrop=true;scene.add(pn);const gl=noRay(new THREE.Sprite(softSprite('#fff4dc',.3)));gl.scale.set(6.2,3.4,1);gl.position.set(wx,1.5,bz+.26);gl.userData.fx=true;scene.add(gl);
  if(!j){const frM=std({color:'#e8e4da',roughness:.5});for(const dx of[-1.5,0,1.5]){const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(.06,1.56,.05),frM));fr.position.set(wx+dx,1.55,bz+.06);fr.userData.backdrop=true;scene.add(fr);}for(const dy of[-.75,.75]){const fr=noRay(new THREE.Mesh(new THREE.BoxGeometry(3.06,.06,.05),frM));fr.position.set(wx,1.55+dy,bz+.06);fr.userData.backdrop=true;scene.add(fr);}}
  const lights=setLights([new THREE.HemisphereLight('#fff6e6','#6e5a44',1.05),shadowKey(dirL('#fff1d8',1.9,wx,3.2,-2.5),o.size||7),dirL('#ffe9cf',.5,-3,2.6,4)]);return{lights};},
 town_dusk(o){const s={a:'#f4b27e',b:'#d2857e',c:'#5a638f',d:'#1a2547',cl:'#6d5a78',cloud:.65};const sk=makeSky(s);skyEnv(s,'#4a4c54',[[-10,10,12,30,2,'#ffe2c6',6],[12,9,-10,20,3,'#ffc69c',5],[0,6,24,36,1,'#fff0dc',2]]);scene.background=new THREE.Color('#1a2547');scene.fog=new THREE.FogExp2(new THREE.Color('#6d6677'),.02);
  ground('asphalt',{size:90,color:'#4c4d52',rough:.72,name:'道路'});
  const walk=surface('concrete',{color:'#83827e'});const sw=noRay(plane(90,3.2,walk,{rot:[-Math.PI/2,0,0],at:[0,.09,-5.6],name:'歩道',backdrop:true}));sw.castShadow=false;const curb=noRay(new THREE.Mesh(new THREE.BoxGeometry(90,.12,.16),std({color:'#9b9a95',roughness:.85})));curb.position.set(0,.06,-3.98);curb.userData.backdrop=true;scene.add(curb);
  const lineM=emitless('#d8d6cf');for(let i=-8;i<=8;i++){const l=noRay(new THREE.Mesh(new THREE.PlaneGeometry(2,.1),lineM));l.rotation.x=-Math.PI/2;l.position.set(i*3.6,.004,3.2);l.userData.backdrop=true;scene.add(l);}
  const cols=['#7d756d','#6e7380','#8a7a68','#6b6a74','#7a6e66','#70757c'];for(let i=0;i<8;i++){const x=(i-3.5)*7.6+rnd(-.6,.6),w=rnd(5.2,6.6),h=rnd(2.8,4.2);miniHouse(x,-11+rnd(-.8,.8),w,5,h,rnd(-.04,.04),{wall:cols[i%6],roof:i%2?'#3a3d47':'#44393a',windows:3,lit:undefined});}
  for(let i=0;i<4;i++){const x=(i-1.5)*13;const M=std({color:'#3a3a3c',roughness:.8}),p=noRay(new THREE.Mesh(new THREE.CylinderGeometry(.09,.13,7.4,10),M));p.position.set(x,3.7,-7.2);p.userData.backdrop=true;scene.add(p);const a=noRay(new THREE.Mesh(new THREE.BoxGeometry(1.5,.08,.08),M));a.position.set(x,6.9,-7.2);a.userData.backdrop=true;scene.add(a);}
  const wireM=new THREE.MeshBasicMaterial({color:'#1f1f25',fog:true});for(const dz of[-.6,0,.6]){const pts=[];for(let i=0;i<=30;i++){const x=(i/30-.5)*39*1.0,sag=Math.sin(((x/13+1.5)%1)*Math.PI);pts.push(V(x,6.9-sag*.4,-7.2+dz*.5));}const w=noRay(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts),120,.012,4,false),wireM));w.userData.backdrop=true;scene.add(w);}
  const lamp=streetLamp(-6.5,-4.6,{power:78,tz:5,arm:1.1,h:5.2}),lamp2=streetLamp(11,-4.6,{light:false,h:5.2});
  const lights=setLights([new THREE.HemisphereLight('#c8d0ee','#66564c',.78),shadowKey(dirL('#ffd2a6',1.4,-7,6,6),o.size||8),dirL('#8ea4d8',.4,8,5,-5)]);return{sky:sk,lights:[...lights,{l:lamp.light,i:lamp.light.intensity}]};},
 field_day(o){const s={a:'#e8efe9',b:'#c8def0',c:'#8fbfe8',d:'#3f7fce',cl:'#ffffff',cloud:.92};const sk=makeSky(s);skyEnv(s,'#75805f',[[10,20,8,24,4,'#fffbe8',12],[-14,8,-8,20,3,'#dbe8ff',2.5]]);scene.background=new THREE.Color('#8fbfe8');scene.fog=new THREE.FogExp2(new THREE.Color('#c4d8e6'),.013);
  ground(o.ground||'grass',{size:120,color:o.groundColor,name:'地面'});
  const hillM=new THREE.MeshStandardMaterial({color:'#5f8263',roughness:1,flatShading:false,envMapIntensity:.2});for(const[x,z,sx,sy,sz]of[[-34,-52,46,10,20],[18,-60,60,14,22],[52,-46,40,8,18],[-70,-40,36,8,18]]){const h=noRay(new THREE.Mesh(new THREE.SphereGeometry(1,28,14),hillM));h.position.set(x,0,z);h.scale.set(sx,sy,sz);h.userData.backdrop=true;scene.add(h);}
  scatter(roundTreeGeo(),o.trees??26,10,40,{dz:-10,keep:(x,z)=>z<-5||Math.abs(x)>12,s0:1,s1:2.1});
  if(o.fence!==false){const M=wood({base:'#8d7253',late:'#68523a',rings:8,scale:2,along:'y'}),R=wood({base:'#8d7253',late:'#68523a',rings:8,scale:2});for(let i=-5;i<=5;i++){const p=noRay(new THREE.Mesh(new THREE.BoxGeometry(.1,1,.1),M));p.position.set(i*2.4,.5,-8);p.userData.backdrop=true;p.castShadow=true;scene.add(p);}for(const y of[.45,.8]){const r=noRay(new THREE.Mesh(new THREE.BoxGeometry(24.4,.07,.04),R));r.position.set(0,y,-8);r.userData.backdrop=true;r.castShadow=true;scene.add(r);}}
  const lights=setLights([new THREE.HemisphereLight('#cfe3ff','#6e7a58',1.05),shadowKey(dirL('#fff4dc',2.5,8,14,7),o.size||9)]);return{sky:sk,lights};},
 studio(o){const dark=o.tone!=='light',base=o.color||(dark?'#23272d':'#d9d5cb'),top=new THREE.Color(base).multiplyScalar(dark?.45:1.08);const s={a:base,b:base,c:'#'+top.getHexString(),d:'#'+top.getHexString()};const sk=makeSky(s);skyEnv(s,base,[[-7,12,8,14,6,'#ffffff',dark?9:5],[8,7,-6,4,12,'#ffffff',dark?5:3],[0,4,14,20,1,'#ffffff',2]]);scene.background=new THREE.Color(base);scene.fog=new THREE.FogExp2(new THREE.Color(base),.036);
  const fm=std({color:base,roughness:dark?.5:.7,envMapIntensity:.55}),f=plane(160,160,fm,{rot:[-Math.PI/2,0,0],name:'床',backdrop:true});f.castShadow=false;
  const pool=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:softTex,color:new THREE.Color(dark?'#ffffff':'#fff6e4'),transparent:true,opacity:dark?.12:.28,depthWrite:false,blending:THREE.AdditiveBlending}));pool.rotation.x=-Math.PI/2;pool.scale.setScalar(o.pool||16);pool.position.y=.004;pool.userData.fx=true;noRay(pool);scene.add(pool);
  const lights=setLights([new THREE.HemisphereLight('#f4f2ee',dark?'#22252a':'#a9a496',dark?.72:1.1),shadowKey(dirL('#fff4e4',dark?2.1:1.9,-3.5,8,4.5),o.size||7),dirL('#b9d0ee',dark?.7:.35,6,3.5,-3.5)]);return{sky:sk,lights};},
};
function emitless(c){return new THREE.MeshStandardMaterial({color:new THREE.Color(c),roughness:.8,transparent:true,opacity:.92,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});}
let worldUsed=false;
function world(kind='studio',o={}){const f=WORLDS[kind];if(!f)bad('world','種類は '+Object.keys(WORLDS).join(' / '));worldUsed=true;const q={clear:7,...o};const keep=seed;seed=20261105+kind.length*131;const r=f(q)||{};seed=keep;const L=r.lights||[];
 return{kind,lights:L,snow:r.snow||null,sky:r.sky||null,
  // 世界を暗くして、見えない物を目立たせる（a=1 ふつう、a=.3 暗い）
  dim(a){const v=clamp(a);for(const e of L)e.l.intensity=e.i*v;if(r.sky)r.sky.mat.uniforms.uDim.value=mix(.28,1,v);renderer.toneMappingExposure=1.05*mix(.48,1,v);return this;}};}

// ===== 透かす：外側を消して輪郭だけ残す =====
const GHOSTV='varying vec3 vN,vV;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);vN=normalMatrix*normal;vV=-mv.xyz;gl_Position=projectionMatrix*mv;}';
const GHOSTF='varying vec3 vN,vV;uniform float uA;uniform vec3 uC;void main(){float f=pow(1.-abs(dot(normalize(vN),normalize(vV))),2.4);gl_FragColor=vec4(uC,(f*.85+.035)*uA);\n#include <colorspace_fragment>\n}';
function xray(obj,o={}){if(!obj||!obj.traverse)bad('xray','物やグループを渡す');const u={uA:{value:0},uC:{value:new THREE.Color(o.color||'#cfeaff')}},gm=new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,toneMapped:false,vertexShader:GHOSTV,fragmentShader:GHOSTF});
 const list=[],ghosts=[];const seen=[];obj.traverse(n=>{if(n.isMesh&&!n.userData.fx&&!n.userData.ghost)seen.push(n);});
 for(const n of seen){const f=cloneMat(n.material);f.transparent=true;f.userData.base=n.material.opacity;n.material=f;list.push({n,f,cast:n.castShadow});if(n.userData.noGhost)continue;const g=noRay(new THREE.Mesh(n.userData.ghostGeo||n.geometry,gm));g.userData.ghost=true;g.userData.fx=true;g.renderOrder=5;g.visible=false;n.add(g);ghosts.push(g);}
 return{set(a){a=clamp(a);u.uA.value=a;for(const e of list){const k=1-a;e.f.opacity=e.f.userData.base*k;e.f.visible=k>.004;e.f.depthWrite=k>.97&&!e.n.material.userData.noDepth;e.n.castShadow=e.cast&&k>.5;}for(const g of ghosts)g.visible=a>.004;return this;}};}

// ===== 切り口：平面より向こうを消す =====
function cut(obj,o={}){if(!obj||!obj.traverse)bad('cut','物やグループを渡す');renderer.localClippingEnabled=true;const n=V(...vec3('cut',o.normal||[0,0,-1])).normalize(),base=V(...vec3('cut',o.at||[0,0,0])),pl=new THREE.Plane(n.clone(),-n.dot(base));
 obj.traverse(m=>{if(!m.isMesh||m.userData.fx)return;const f=cloneMat(m.material);f.clippingPlanes=[pl];f.clipShadows=true;f.side=THREE.DoubleSide;m.material=f;});
 return{plane:pl,set(k,far=4){pl.constant=-n.dot(base)+(1-clamp(k))*far;return this;}};}

// ===== 重なり：見えない層を、持ち上げて分けて見せる =====
function strata(layers,o={}){if(!Array.isArray(layers)||!layers.length)bad('strata','[{h,mat,name},...] を渡す');const w=o.w||3,d=o.d||2,st=o.stair||0,ax=o.axis==='z'?'z':'y',gr=group({at:o.at,rot:o.rot,name:o.name||'重なり',parent:o.parent});let y=0;
 const parts=layers.map((L,i)=>{const h=L.h||.1;if(!L.mat||!L.mat.isMaterial)bad('strata',(i+1)+'番目の mat がありません');const wi=(L.w||w)-st*i,off=-st*i/2,dd=L.d||d,rd=o.round??Math.min(.02,h*.3),m=ax==='y'?rbox(wi,h,dd,rd,L.mat,{parent:gr,at:[off,y+h/2,0],name:L.name||'層'}):rbox(wi,dd,h,rd,L.mat,{parent:gr,at:[off,0,y+h/2],name:L.name||'層'});const q={m,y0:y+h/2,h,wi,off};y+=h;return q;});
 const out=(x,yy,zz)=>{gr.updateMatrixWorld(true);const v=V(x,yy,zz);gr.localToWorld(v);return[v.x,v.y,v.z];};const at=(i,a,gap)=>parts[i].y0+clamp(a)*(gap??o.gap??.5)*i;
 return{group:gr,parts,height:y,open(a,gap=o.gap||.5){parts.forEach((q,i)=>{q.m.position[ax]=q.y0+clamp(a)*gap*i;});return this;},
  center(i,a=1,gap=o.gap||.5){return ax==='y'?out(parts[i].off,at(i,a,gap),0):out(parts[i].off,0,at(i,a,gap));},
  // その層の表面で、上の層に隠れていない所（名札の点に使う）
  spot(i,a=0,gap=o.gap||.5){const q=parts[i],last=i===parts.length-1,x=last||!st?q.off:q.off+q.wi/2-st/2,sf=at(i,a,gap)+q.h/2+.002;return ax==='y'?out(x,sf,0):out(x,0,sf);}};}

// ===== しみ：色と形で見えるようにする =====
let stainSeed=7;
function stainCanvas(sd,c,edge){const keep=seed;seed=sd;const t=tex(512,(g,s)=>{const rgb=x=>{const k=new THREE.Color(x);return`rgb(${Math.round(k.r**(1/2.2)*255)},${Math.round(k.g**(1/2.2)*255)},${Math.round(k.b**(1/2.2)*255)})`;};
  g.clearRect(0,0,s,s);const P=[rnd(6.3),rnd(6.3),rnd(6.3),rnd(6.3),rnd(6.3)],sq=rnd(.72,.95);
  const fr=a=>1+.14*Math.sin(2*a+P[0])+.09*Math.sin(3*a+P[1])+.055*Math.sin(5*a+P[2])+.03*Math.sin(9*a+P[3])+.016*Math.sin(17*a+P[4]);
  const shape=(R,col,blur)=>{g.shadowColor=col;g.shadowBlur=blur;g.fillStyle=col;g.beginPath();for(let i=0;i<=220;i++){const a=i/220*6.283,q=R*fr(a),x=(.5+Math.cos(a)*q)*s,y=(.5+Math.sin(a)*q*sq)*s;if(i)g.lineTo(x,y);else g.moveTo(x,y);}g.closePath();g.fill();g.shadowBlur=0;};
  const ce=rgb(edge),cc=rgb(c);shape(.375,ce,16);
  // 飛び散った小さな粒（丸を並べただけの形にしない）
  g.fillStyle=ce;for(let i=0;i<14;i++){const a=rnd(6.283),q=.375*fr(a)+rnd(.015,.075),rr=rnd(.003,.014)*s;g.beginPath();g.ellipse((.5+Math.cos(a)*q)*s,(.5+Math.sin(a)*q*sq)*s,rr,rr*rnd(.6,1),rnd(3),0,7);g.fill();}
  shape(.35,cc,10);g.globalCompositeOperation='source-atop';for(let i=0;i<60;i++){g.globalAlpha=rnd(.03,.09);g.fillStyle=i%2?'#ffffff':'#000000';g.beginPath();g.ellipse(rnd(s),rnd(s),rnd(10,60),rnd(6,30),rnd(3),0,7);g.fill();}g.globalAlpha=1;g.globalCompositeOperation='source-over';});seed=keep;t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;return t;}
function stain(at,r=.4,o={}){const pos=V(...vec3('stain',at)),c=o.color||'#e0a53c',edge=o.edge||'#fff0c2',sd=(stainSeed+=37),gp=new THREE.Group();gp.position.copy(pos);(o.parent||scene).add(gp);if(o.normal){gp.quaternion.setFromUnitVectors(V(0,1,0),V(...o.normal).normalize());}
 const map=stainCanvas(sd,c,edge),m=new THREE.MeshPhysicalMaterial({map,transparent:true,depthWrite:false,roughness:o.wet===false?.8:.26,clearcoat:o.wet===false?0:.8,clearcoatRoughness:.12,envMapIntensity:1.1,emissive:new THREE.Color(c),emissiveMap:map,emissiveIntensity:.5,polygonOffset:true,polygonOffsetFactor:-3});
 const p=new THREE.Mesh(new THREE.PlaneGeometry(r*2,r*2),m);p.rotation.x=-Math.PI/2;p.rotation.z=rnd(6.283);p.position.y=.004;p.renderOrder=2;p.receiveShadow=true;p.name=o.name||'しみ';p.userData.fx=true;noRay(p);gp.add(p);
 const T={pos,r,alpha:1,name:p.name};imgTargets.push(T);const api={obj:gp,set(a=1,grow){const q=clamp(a);T.alpha=q;m.opacity=q;p.visible=q>.01;const g=grow===undefined?ss(0,.7,q):clamp(grow);p.scale.setScalar(mix(.4,1,g));T.r=r*mix(.4,1,g);return this;}};return api;}

// ===== におい・湯気・熱：ゆらめく帯で見せる（粒で画面を埋めない）=====
let wispBudget=phone?40:64;
// 橙・赤・黄の帯は火に見える（灯油やガスの場面では特に事故に見える）ので、色を入れかえる
function noFire(c,safe){if(!c)return safe;const h={};new THREE.Color(c).getHSL(h);return(h.h<=.17||h.h>=.95)&&h.s>.2?safe:c;}
// もやの色：うすすぎると明るい物の上で消えるので、明るさと色の濃さに枠をつける
function moyaColor(c,lMax){const q=new THREE.Color(c),h={};q.getHSL(h);return q.setHSL(h.h,Math.max(h.s,.5),Math.min(h.l,lMax));}
function wisp(at,o={}){const pos=V(...vec3('wisp',at)),sp=vec3('wisp',o.spread||[.15,0,.15]),n=Math.min(Math.round(o.n||7),18,wispBudget);wispBudget-=n;const seg=22,P=[],U=[],B=[],R=[],idx=[];
 for(let k=0;k<n;k++){const bx=rnd(-sp[0],sp[0]),by=rnd(-sp[1],sp[1]),bz=rnd(-sp[2],sp[2]),s1=rand(),s2=rand(),s=P.length/3;for(let i=0;i<=seg;i++){for(const e of[-1,1]){P.push(0,0,0);U.push(e,i/seg);B.push(pos.x+bx,pos.y+by,pos.z+bz);R.push(s1,s2);}}for(let i=0;i<seg;i++){const a=s+i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2);}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('aU',new THREE.Float32BufferAttribute(U,2));g.setAttribute('aB',new THREE.Float32BufferAttribute(B,3));g.setAttribute('aR',new THREE.Float32BufferAttribute(R,2));g.setIndex(idx);
 const u={uT:timeU,uH:{value:0},uA:{value:0},uTall:{value:o.height||1},uW:{value:Math.max(o.width||.16,.13)},uCurl:{value:o.curl??.2},uDrift:{value:V(...(o.drift||[0,0,0]))},uC:{value:moyaColor(noFire(o.color,'#bfe06e'),.66)},uC2:{value:moyaColor(noFire(o.color2||o.color,'#f1ffc4'),.78)}};
 const m=new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
  vertexShader:`attribute vec2 aU;attribute vec3 aB;attribute vec2 aR;uniform float uT,uH,uTall,uW,uCurl;uniform vec3 uDrift;varying vec2 vU;varying float vS;
   void main(){float y=aU.y;float tall=uTall*uH*(.6+.4*aR.x);float yy=y*tall;vec3 w=aB+vec3(0.,yy,0.)+uDrift*y*y*uH;float ph=y*(3.4+1.8*aR.y)-uT*(.32+.3*aR.y)+aR.x*6.283;float amp=uCurl*min(1.,tall*1.2)*(.12+y*.9)*(.75+.5*aR.y);float top=smoothstep(.55,.92,normalize(cameraPosition-w).y);amp*=1.+top*2.4;w.x+=sin(ph)*amp;w.z+=cos(ph*.8+1.3)*amp;
    vec4 mv=viewMatrix*vec4(w,1.);float wd=uW*pow(sin(3.1416*min(1.,y*.92+.04)),.7)*(.8+.5*aR.y)*(1.+top*.9);mv.x+=aU.x*wd;gl_Position=projectionMatrix*mv;vU=aU;vS=aR.x;}`,
  fragmentShader:`varying vec2 vU;varying float vS;uniform float uA,uT;uniform vec3 uC,uC2;void main(){float e=1.-abs(vU.x);float core=smoothstep(0.,.9,e);float en=smoothstep(0.,.12,vU.y)*(1.-smoothstep(.62,1.,vU.y));vec3 c=mix(uC,uC2,core*core);gl_FragColor=vec4(c,core*core*en*uA);\n#include <colorspace_fragment>\n}`});
 const mh=noRay(new THREE.Mesh(g,m));mh.frustumCulled=false;mh.renderOrder=7;mh.userData.fx=true;mh.visible=false;(o.parent||scene).add(mh);
 const T={pos:pos.clone(),r:Math.max(o.height||1,Math.max(sp[0],sp[2])+.2),alpha:0,name:o.name||'におい'};imgTargets.push(T);const maxA=Math.max(o.opacity??.85,.7);
 // まわりの薄いもや（帯だけだと線に見える）
 const hz=noRay(new THREE.Sprite(softSprite(noFire(o.color,'#bfe06e'),1)));hz.userData.fx=true;hz.renderOrder=6;const hzH=(o.height||1)*.95+.2,hzW=Math.max(sp[0],sp[2])*2.2+.55;hz.scale.set(hzW,hzH,1);hz.position.set(pos.x,pos.y+hzH*.36,pos.z);hz.visible=false;(o.parent||scene).add(hz);const hzA=o.haze??.22,hzD=Math.max(sp[2],sp[0]*.6)*2.2+.55;let hzK=0;
 afterCamFx.push(()=>{if(!hz.visible)return;const top=ss(.55,.92,(camera.position.y-pos.y)/Math.max(.01,camera.position.distanceTo(pos)));hz.scale.y=mix(hzH,hzD,top);hz.material.opacity=hzK*(1+top*1.5);});
 return{obj:mh,set(h=1,a=1){u.uH.value=Math.max(0,h);u.uA.value=clamp(a)*maxA;T.alpha=h>.02?clamp(a):0;mh.visible=u.uA.value>.004&&h>.01;hzK=hzA*clamp(a)*clamp(h*1.6);hz.material.opacity=hzK;hz.visible=mh.visible&&hzA>0;return this;}};}

// ===== 流れ：水・空気・電気・熱の通り道 =====
function flow(pts,o={}){if(!Array.isArray(pts)||pts.length<2)bad('flow','[x,y,z] を2つ以上');const curve=new THREE.CatmullRomCurve3(pts.map(a=>V(...a))),r=o.r||.03;const g=new THREE.TubeGeometry(curve,o.seg||90,r,10,false);const u={uT:timeU,uP:{value:0},uA:{value:0},uS:{value:o.speed??.6},uN:{value:o.dashes??9},uC:{value:new THREE.Color(o.color||S.accent||'#7fd8e8')}};
 const m=new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,toneMapped:false,vertexShader:'varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'varying vec2 vU;uniform float uT,uP,uA,uS,uN;uniform vec3 uC;void main(){float d=fract(vU.x*uN-uT*uS);float a=.34+.66*smoothstep(.0,.2,d)*(1.-smoothstep(.45,.75,d));a*=1.-smoothstep(uP-.03,uP,vU.x);gl_FragColor=vec4(uC,a*uA);\n#include <colorspace_fragment>\n}'});
 const mh=noRay(new THREE.Mesh(g,m));mh.renderOrder=6;mh.userData.fx=true;mh.visible=false;(o.parent||scene).add(mh);const mid=curve.getPoint(.5),T={pos:mid,r:curve.getLength()*.55,alpha:0,name:o.name||'流れ'};imgTargets.push(T);
 return{obj:mh,set(pr=1,a=1){u.uP.value=clamp(pr)*1.03;u.uA.value=clamp(a);T.alpha=pr>.02?clamp(a):0;mh.visible=u.uA.value>.004&&pr>.01;return this;}};}

// ===== 吹きつける：水・塗料・空気の勢い =====
function spray(from,to,o={}){const a=V(...vec3('spray',from)),b=V(...vec3('spray',to)),dir=b.clone().sub(a),len=dir.length();dir.normalize();const n=Math.min(Math.round(o.n||70),140),P=[],U=[],R=[],idx=[];for(let k=0;k<n;k++){const s=P.length/3,r1=rand(),r2=rand(),r3=rand();for(const[e,f]of[[-1,0],[1,0],[-1,1],[1,1]]){P.push(0,0,0);U.push(e,f);R.push(r1,r2,r3);}idx.push(s,s+1,s+2,s+1,s+3,s+2);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('aU',new THREE.Float32BufferAttribute(U,2));g.setAttribute('aR',new THREE.Float32BufferAttribute(R,3));g.setIndex(idx);
 const up=Math.abs(dir.y)>.9?V(1,0,0):V(0,1,0),e1=new THREE.Vector3().crossVectors(dir,up).normalize(),e2=new THREE.Vector3().crossVectors(dir,e1).normalize();
 const u={uT:timeU,uA:{value:0},uA0:{value:a},uD:{value:dir},uL:{value:len},uE1:{value:e1},uE2:{value:e2},uS:{value:o.spread??.16},uSp:{value:o.speed??1.6},uW:{value:o.width||.012},uC:{value:new THREE.Color(o.color||'#dff2ff')}};
 const m=new THREE.ShaderMaterial({uniforms:u,transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
  vertexShader:`attribute vec2 aU;attribute vec3 aR;uniform float uT,uL,uS,uSp,uW;uniform vec3 uA0,uD,uE1,uE2;varying float vF;varying float vE;
   void main(){float t=fract(aR.x+uT*uSp*(.8+.4*aR.y));float ang=aR.y*6.283,rad=sqrt(aR.z);float sp=uS*t*rad;vec3 c=uA0+uD*(uL*t)+uE1*cos(ang)*sp+uE2*sin(ang)*sp;float ln=uL*.1*(.5+t);vec3 w=c+uD*(aU.y-.5)*ln;vec4 mv=viewMatrix*vec4(w,1.);vec2 dv=normalize((viewMatrix*vec4(uD,0.)).xy+vec2(1e-4));mv.xy+=vec2(-dv.y,dv.x)*aU.x*uW*(.6+t);gl_Position=projectionMatrix*mv;vF=smoothstep(0.,.08,t)*(1.-smoothstep(.93,1.,t));vE=aU.x;}`,
  fragmentShader:`varying float vF;varying float vE;uniform float uA;uniform vec3 uC;void main(){gl_FragColor=vec4(uC,vF*(1.-vE*vE)*uA);\n#include <colorspace_fragment>\n}`});
 const mh=noRay(new THREE.Mesh(g,m));mh.frustumCulled=false;mh.renderOrder=7;mh.userData.fx=true;mh.visible=false;(o.parent||scene).add(mh);
 const hit=noRay(new THREE.Sprite(softSprite(o.color||'#dff2ff',1)));hit.userData.fx=true;hit.renderOrder=6;hit.position.copy(b).addScaledVector(dir,-.02);const hs=(o.spread??.16)*2.6+.12;hit.scale.set(hs,hs,1);hit.visible=false;(o.parent||scene).add(hit);
 const T={pos:a.clone().add(b).multiplyScalar(.5),r:len*.6,alpha:0,name:o.name||'吹きつけ'};imgTargets.push(T);
 return{obj:mh,set(q=1){const k=clamp(q);u.uA.value=k*(o.opacity??.9);hit.material.opacity=k*.34;T.alpha=k;mh.visible=hit.visible=k>.004;return this;}};}

// ===== タイヤとホイール（軸は z）=====
let wheelShared=null;
function wheelParts(r,w,rimC,tireC){if(wheelShared&&wheelShared.key===r+'|'+w+rimC+tireC)return wheelShared;
 const prof=[[r*.63,-w/2],[r*.79,-w*.53],[r*.9,-w*.52],[r*.975,-w*.44],[r,-w*.34],[r,-w*.19],[r-.008,-w*.17],[r-.008,-w*.13],[r,-w*.11],[r,w*.11],[r-.008,w*.13],[r-.008,w*.17],[r,w*.19],[r,w*.34],[r*.975,w*.44],[r*.9,w*.52],[r*.79,w*.53],[r*.63,w/2]].map(a=>new THREE.Vector2(a[0],a[1]));
 const tireM=std({color:tireC,roughness:.8,envMapIntensity:.55}),rim=std({color:rimC,metalness:.9,roughness:.3,envMapIntensity:1.15}),dark=std({color:'#15161a',roughness:.65,metalness:.2}),disc=std({color:'#8e9196',metalness:.85,roughness:.42});
 wheelShared={key:r+'|'+w+rimC+tireC,tire:new THREE.LatheGeometry(prof,56),lip:new THREE.TorusGeometry(r*.645,r*.03,10,56).rotateX(Math.PI/2),barrel:new THREE.CylinderGeometry(r*.63,r*.63,w*.92,40,1,true),back:new THREE.CylinderGeometry(r*.6,r*.6,.01,32),discG:new THREE.CylinderGeometry(r*.44,r*.44,.02,32),hub:new THREE.CylinderGeometry(r*.11,r*.14,.05,20),spoke:new THREE.BoxGeometry(r*.56,.02,r*.075),nut:new THREE.CylinderGeometry(.009,.009,.012,6),tread:new THREE.BoxGeometry(.012,w*.14,.03),tireM,rim,dark,disc};return wheelShared;}
function wheel(r=.325,w=.21,o={}){const P=wheelParts(r,w,o.rim||'#c8ccd2',o.tire||'#2a2b30'),g=group({at:o.at,name:o.name||'タイヤ',parent:o.parent});g.rotation.set(o.side===-1?-Math.PI/2:Math.PI/2,0,0);
 const add=(geo,mat,x=0,y=0,z=0,ry=0)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.y=ry;m.castShadow=true;m.receiveShadow=true;g.add(m);return m;};
 add(P.tire,P.tireM);const lip=add(P.lip,P.rim,0,w*.45,0);add(P.barrel,P.dark);add(P.back,P.dark,0,-w*.3);add(P.discG,P.disc,0,-w*.08);
 for(let i=0;i<5;i++){const a=i/5*Math.PI*2+.3;for(const d of[-.11,.11]){const q=a+d,x=Math.cos(q)*r*.35,z=Math.sin(q)*r*.35;add(P.spoke,P.rim,x,w*.38,z,-q);}}
 add(P.hub,P.rim,0,w*.39);for(let i=0;i<5;i++){const a=i/5*Math.PI*2+.3+Math.PI/5;add(P.nut,P.dark,Math.cos(a)*r*.09,w*.43,Math.sin(a)*r*.09);}
 const n=phone?30:54,tr=noRay(new THREE.InstancedMesh(P.tread,P.dark,n*2)),q=new THREE.Object3D();for(let i=0;i<n*2;i++){const k=i%2?1:-1,a=(i>>1)/n*Math.PI*2+(k>0?.03:0);q.position.set(Math.cos(a)*(r-.001),k*w*.27,Math.sin(a)*(r-.001));q.rotation.set(0,-a,k*.32);q.updateMatrix();tr.setMatrixAt(i,q.matrix);}g.add(tr);
 g.spin=a=>{g.rotation.y=a;};return g;}

// ===== 車：実物の大きさの比で作る（長さ約4.3、幅約1.75、高さ約1.5。前は +x）=====
const CARS={
 wagon:{top:[[-2.15,.72],[-2.12,.86],[-1.95,.97],[-1.2,1.0],[0,1.0],[.85,.97],[1.1,.94],[1.6,.85],[2.0,.74],[2.15,.6]],bot:[[-2.15,.5],[-2.05,.33],[-1.8,.24],[1.85,.23],[2.08,.31],[2.15,.46]],w:[[-2.15,.58],[-2.1,.72],[-1.85,.83],[-1.2,.875],[0,.885],[1.2,.875],[1.75,.82],[2.05,.7],[2.15,.54]],
  gh:[[1.05,.93],[.62,1.2],[.2,1.42],[-.2,1.49],[-.9,1.5],[-1.4,1.47],[-1.76,1.31],[-2.0,1.02],[-2.05,.94]],wx:[1.33,-1.32],r:.325,xA:1.05,xC:-2.05,xRF:.14,xRR:-1.68,bx:-.28,cx:-1.34,frontSeat:.02,rearSeat:-.98,dash:.76,cargo:-1.72,roof:1.5},
 sedan:{top:[[-2.32,.74],[-2.28,.88],[-2.1,1.02],[-1.5,1.04],[0,1.01],[.95,.97],[1.25,.93],[1.8,.84],[2.2,.72],[2.32,.58]],bot:[[-2.32,.52],[-2.2,.34],[-1.95,.24],[2,.23],[2.25,.31],[2.32,.46]],w:[[-2.32,.6],[-2.25,.74],[-1.95,.85],[-1.2,.89],[0,.895],[1.3,.885],[1.9,.82],[2.22,.7],[2.32,.54]],
  gh:[[1.2,.92],[.72,1.16],[.3,1.36],[-.15,1.44],[-.7,1.45],[-1.15,1.41],[-1.5,1.28],[-1.85,1.08],[-2.05,1.02]],wx:[1.42,-1.38],r:.33,xA:1.2,xC:-2.05,xRF:.24,xRR:-1.2,bx:-.3,cx:-1.15,frontSeat:.02,rearSeat:-.98,dash:.82,cargo:-1.85,roof:1.45},
 kei:{top:[[-1.7,.74],[-1.68,.9],[-1.58,1.0],[-1,1.03],[0,1.03],[.8,1.0],[1.05,.96],[1.4,.88],[1.62,.78],[1.7,.62]],bot:[[-1.7,.48],[-1.62,.32],[-1.45,.22],[1.45,.22],[1.64,.3],[1.7,.46]],w:[[-1.7,.55],[-1.66,.66],[-1.45,.72],[-1,.735],[0,.74],[1,.735],[1.4,.71],[1.62,.64],[1.7,.52]],
  gh:[[1.05,.96],[.74,1.28],[.48,1.56],[.2,1.7],[-.4,1.74],[-1.1,1.74],[-1.5,1.68],[-1.62,1.4],[-1.66,1.0]],wx:[1.07,-1.12],r:.285,xA:1.05,xC:-1.66,xRF:.4,xRR:-1.48,bx:-.22,cx:-1.18,frontSeat:.08,rearSeat:-.82,dash:.72,cargo:-1.42,roof:1.74},
 van:{top:[[-2.35,.8],[-2.33,.96],[-2.2,1.06],[-1.2,1.08],[0,1.08],[.95,1.05],[1.3,1.0],[1.8,.9],[2.25,.78],[2.35,.62]],bot:[[-2.35,.52],[-2.25,.34],[-2,.26],[1.95,.25],[2.28,.33],[2.35,.48]],w:[[-2.35,.66],[-2.3,.78],[-2,.87],[-1.2,.89],[0,.895],[1.3,.885],[1.9,.83],[2.25,.72],[2.35,.56]],
  gh:[[1.32,1],[.92,1.34],[.55,1.68],[.15,1.84],[-.6,1.88],[-1.5,1.87],[-2.1,1.8],[-2.28,1.5],[-2.33,1.05]],wx:[1.46,-1.42],r:.33,xA:1.32,xC:-2.33,xRF:.42,xRR:-2.12,bx:-.1,cx:-1.9,frontSeat:.18,rearSeat:-.9,dash:.92,cargo:-1.92,roof:1.88},
 suv:{top:[[-2.2,.82],[-2.17,.98],[-2,1.1],[-1.2,1.13],[0,1.13],[.9,1.1],[1.2,1.06],[1.7,.98],[2.08,.86],[2.2,.7]],bot:[[-2.2,.56],[-2.1,.42],[-1.85,.31],[1.9,.3],[2.12,.4],[2.2,.54]],w:[[-2.2,.62],[-2.15,.78],[-1.9,.88],[-1.2,.915],[0,.925],[1.2,.915],[1.8,.86],[2.1,.74],[2.2,.58]],
  gh:[[1.12,1.05],[.7,1.34],[.28,1.58],[-.15,1.66],[-.9,1.67],[-1.5,1.64],[-1.86,1.46],[-2.08,1.16],[-2.12,1.08]],wx:[1.36,-1.36],r:.37,xA:1.12,xC:-2.12,xRF:.2,xRR:-1.74,bx:-.28,cx:-1.4,frontSeat:.02,rearSeat:-1.0,dash:.8,cargo:-1.76,roof:1.67},
};
function car(o={}){const D=CARS[o.kind||'wagon'];if(!D)bad('car','kind は '+Object.keys(CARS).join(' / '));const at=o.at||[0,0,0];
 const root=group({at,rot:o.rot,scale:o.scale,name:o.name||'車',parent:o.parent}),shell=group({parent:root,name:'車の外側'}),cabin=group({parent:root,name:'車の中'});
 const paint=new THREE.MeshPhysicalMaterial({color:color(o.color||'#b8bec6'),metalness:.45,roughness:.36,clearcoat:1,clearcoatRoughness:.07,envMapIntensity:1.05});
 const glassM=new THREE.MeshPhysicalMaterial({color:'#14222c',roughness:.05,metalness:.75,transparent:true,opacity:o.glass??.64,envMapIntensity:1.55,clearcoat:1,clearcoatRoughness:.03});glassM.depthWrite=false;glassM.userData.noDepth=true;
 const blackM=std({color:'#17191d',roughness:.5,metalness:.1,envMapIntensity:.6}),plastic=std({color:'#23252a',roughness:.82,envMapIntensity:.45}),chrome=std({color:'#d6dade',metalness:1,roughness:.16,envMapIntensity:1.3});
 const ghT=D.gh.slice().sort((a,b)=>a[0]-b[0]),T=x=>spl(D.top,x),Wd=x=>spl(D.w,x),Rf=x=>spl(ghT,x),arch=D.r+.075,wy=D.r;
 const Bt=x=>{let b=spl(D.bot,x);for(const w of D.wx){const dx=Math.abs(x-w);if(dx<arch)b=Math.max(b,wy+Math.sqrt(arch*arch-dx*dx));}return b;};
 const xs=D.top[0][0],xe=D.top[D.top.length-1][0];
 const Sf=(x,th,off=0)=>{const To=T(x),B=spl(D.bot,x),cy=(To+B)/2,hy=(To-B)/2,c=Math.cos(th),s=Math.sin(th);let y=cy+hy*pw(s,.4),z=Wd(x)*pw(c,.36);const base=(y-B)/(To-B);z*=1-.028*ss(.76,1,base)-.018*ss(.26,0,base)+.01*Math.exp(-((base-.72)**2)/.0014);if(Math.abs(z)>Wd(x)-.36)for(const w of D.wx){const dx=Math.abs(x-w);if(dx<arch)y=Math.max(y,wy+Math.sqrt(arch*arch-dx*dx));}if(off){z+=Math.sign(c)*off*Math.pow(Math.abs(c),.5);y+=Math.sign(s)*off*Math.pow(Math.abs(s),.5);}return[x,y,z];};
 const roofMax=D.roof;
 const Gh=(x,th,off=0)=>{const b=T(x)-.065,R=Math.max(b+.0005,Rf(x)),c=Math.cos(th),s=Math.max(Math.sin(th),0),y=b+(R-b)*Math.pow(s,.42),k=(y-b)/Math.max(.01,roofMax-b);let z=(Wd(x)*.885-.006)*pw(c,.55)*(1-.17*Math.pow(k,1.2));if(off){z+=Math.sign(c)*off;}return[x,y+(off?off*s:0),z];};
 // 胴体
 const nx=phone?150:230,nr=phone?56:84,bodyG=gridGeo(nx,nr,(u,v)=>{const x=mix(xs,xe,u),th=v*Math.PI*2;return Sf(x,th);},true);bodyG.computeVertexNormals();const add=(g,m,parent=shell,name)=>{const q=new THREE.Mesh(g,m);q.castShadow=q.receiveShadow=true;if(name)q.name=name;parent.add(q);return q;};
 const bq=add(bodyG,paint,shell,'車体');{const cut=(x,th)=>{const dx=Math.min(...D.wx.map(w=>Math.abs(x-w)));if(dx>=arch+.01)return false;const To=T(x),B=spl(D.bot,x),c=Math.cos(th),s=Math.sin(th),y=(To+B)/2+(To-B)/2*pw(s,.4),z=Wd(x)*pw(c,.36);return Math.abs(z)>Wd(x)-.42&&y<wy+Math.sqrt(Math.max(0,(arch+.01)**2-dx*dx));};const gn=nx,gr0=nr,ghG=gridGeo(gn,gr0,(u,v)=>Sf(mix(xs,xe,u),v*Math.PI*2),true,(i,j)=>!cut(mix(xs,xe,(i+.5)/gn),(j+.5)/gr0*Math.PI*2));ghG.computeVertexNormals();bq.userData.ghostGeo=ghG;}const capP=x=>{const pts=[];for(let j=0;j<nr;j++)pts.push(Sf(x,j/nr*Math.PI*2));return pts;};const c1=capGeo(nr,capP(xs).reverse());c1.computeVertexNormals();add(c1,paint,shell);const c2=capGeo(nr,capP(xe));c2.computeVertexNormals();add(c2,paint,shell);
 // 窓まわり：ガラス・屋根・柱を面ごとに分ける
 const gu=phone?90:140,gv=phone?30:44,thOf=v=>{const w=v<.5?v*2:(1-v)*2,th=w<.7?Math.asin(Math.pow(w/.7*.88,2.38)):mix(Math.asin(Math.pow(.88,2.38)),Math.PI/2,(w-.7)/.3);return v<.5?th:Math.PI-th;};
 const zone=(xm,v)=>{const w=v<.5?v*2:(1-v)*2;if(w<.045)return'black';if(w<.56){if(Math.abs(xm-D.bx)<.05)return'black';if(xm<D.cx)return'paint';return'glass';}if(w<.72)return'paint';return xm<D.xRF&&xm>D.xRR?'paint':'glass';};
 const ghFn=(u,v)=>Gh(mix(D.xC,D.xA,u),thOf(v));const bucket=name=>gridGeo(gu,gv,ghFn,false,(i,j)=>zone(mix(D.xC,D.xA,(i+.5)/gu),(j+.5)/gv)===name);
 for(const[n,m,na]of[['glass',glassM,'窓ガラス'],['paint',paint,'屋根'],['black',blackM,'窓わく']]){const g=bucket(n);g.computeVertexNormals();const q=add(g,m,shell,na);q.castShadow=n!=='glass';q.renderOrder=n==='glass'?3:0;}
 // 体に沿って貼る細部
 const patch=(x0,x1,t0,t1,off,mat,name,nu=20,nv=10)=>{const g=gridGeo(nu,nv,(u,v)=>Sf(mix(x0,x1,u),mix(t0,t1,v)*DEG,off));g.computeVertexNormals();const q=add(g,mat,shell,name);return q;};
 const headM=new THREE.MeshPhysicalMaterial({color:'#dfe6ee',roughness:.06,metalness:.25,clearcoat:1,envMapIntensity:o.lights===true?1.5:.75,emissive:new THREE.Color(o.lights===false?'#000000':'#fff1d0'),emissiveIntensity:o.lights===true?.8:o.lights===false?0:.12});
 const tailM=new THREE.MeshPhysicalMaterial({color:'#a01418',roughness:.1,metalness:.2,clearcoat:1,envMapIntensity:1.2,emissive:new THREE.Color('#ff2a2a'),emissiveIntensity:.25});
 const front=xe,rear=xs,side=(x0,x1,a,b,off,mat,name)=>{patch(x0,x1,a,b,off,mat,name);patch(x0,x1,180-b,180-a,off,mat,name);};
 const lens=(x0,x1,c0,c1,h0,mat,name)=>{for(const zs of[1,-1]){const g=gridGeo(18,8,(u,v)=>{const x=mix(x0,x1,u),hw=h0*Math.sqrt(Math.max(.02,1-(2*u-1)**2*.92)),d=mix(c0,c1,u)+mix(-hw,hw,v);return Sf(x,(zs>0?d:180-d)*DEG,.004);});if(zs<0){const ix=g.index.array;for(let i=0;i<ix.length;i+=3){const t=ix[i+1];ix[i+1]=ix[i+2];ix[i+2]=t;}}g.computeVertexNormals();add(g,mat,shell,name);}};
 lens(front-.46,front-.05,30,14,10,headM,'ライト');lens(rear+.04,rear+.36,26,38,11,tailM,'後ろのライト');
 // 下まわりの黒い部分と窓の下の光る線
 const sill=(x0,x1)=>side(x0,x1,-46,-24,.004,plastic,'下の縁');sill(D.wx[1]+arch+.01,D.wx[0]-arch-.01);side(front-.32,front-.04,-66,-30,.004,plastic,'前のバンパー');side(rear+.04,rear+.3,-66,-30,.004,plastic,'後ろのバンパー');
 // ドアのすき間
 const seam=std({color:'#111316',roughness:.6}),tubeS=(pts,r=.0048,m=seam)=>{const g=new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p=>V(...p))),Math.max(16,pts.length*3),r,5,false);const q=new THREE.Mesh(g,m);q.castShadow=false;shell.add(q);return q;};
 const doorX=[D.xA-.28,D.bx,D.cx+.03],sideTh=[-22,62];for(const zs of[1,-1]){const th=d=>(zs>0?d:180-d)*DEG;for(const x of doorX){const pts=[];for(let i=0;i<=10;i++)pts.push(Sf(x,th(mix(sideTh[0],sideTh[1],i/10)),.0015));tubeS(pts);}
  const low=[];for(let i=0;i<=20;i++)low.push(Sf(mix(doorX[2],doorX[0],i/20),th(sideTh[0]),.0015));tubeS(low);
  // 窓の下の銀の線
  const bl=[];for(let i=0;i<=24;i++){const x=mix(D.cx,D.xA-.15,i/24),g=Gh(x,th(1.4));bl.push([g[0],g[1]+.002,g[2]+zs*.004]);}tubeS(bl,.0075,chrome);
  // ドアの取っ手
  for(const x of[D.bx+.14,D.cx+.18]){const p=Sf(x,th(20),.006);const h=new THREE.Mesh(new RoundedBoxGeometry(.135,.03,.024,3,.01),paint);h.position.set(p[0],p[1],p[2]+zs*.006);h.castShadow=true;shell.add(h);}
  // ドアミラー
  const mp=Gh(D.xA-.18,th(7)),mir=new THREE.Mesh(pillowGeo(.1,.095,.18,.035,.012,2),paint);mir.position.set(mp[0]-.01,mp[1]+.045,mp[2]+zs*.13);mir.castShadow=true;shell.add(mir);const mst=new THREE.Mesh(new RoundedBoxGeometry(.05,.02,.1,2,.008),blackM);mst.position.set(mp[0],mp[1]+.005,mp[2]+zs*.05);shell.add(mst);const mg=new THREE.Mesh(new THREE.PlaneGeometry(.1,.08),chrome);mg.rotation.y=Math.PI/2+zs*.0;mg.position.set(mp[0]-.062,mp[1]+.045,mp[2]+zs*.13);mg.rotation.y=-Math.PI/2;shell.add(mg);}
 // 顔とお尻
 const faceY=T(front-.02)*.5+Bt(front-.02)*.5,gr=new THREE.Mesh(new RoundedBoxGeometry(.05,.15,Wd(front)*1.42,3,.02),blackM);gr.position.set(front-.01,faceY-.04,0);gr.userData.noGhost=true;shell.add(gr);for(const dy of[-.04,.03]){const b=new THREE.Mesh(new RoundedBoxGeometry(.02,.012,Wd(front)*1.38,2,.005),chrome);b.position.set(front+.018,faceY-.04+dy,0);b.userData.noGhost=true;shell.add(b);}
 const plateM=std({color:'#dfe2d6',roughness:.5});const pf=new THREE.Mesh(new RoundedBoxGeometry(.018,.1,.32,2,.005),plateM);pf.position.set(front+.015,faceY-.19,0);pf.userData.noGhost=true;shell.add(pf);const pr=new THREE.Mesh(new RoundedBoxGeometry(.018,.1,.32,2,.005),plateM);pr.position.set(rear-.012,(T(rear)+Bt(rear))*.5-.02,0);pr.userData.noGhost=true;shell.add(pr);
 // ワイパー
 for(const dz of[-.3,.3]){const a=Gh(D.xA-.16,90*DEG),w=new THREE.Mesh(new RoundedBoxGeometry(.018,.012,.52,2,.004),blackM);w.position.set(a[0]+.01,a[1]+.016,dz);w.rotation.y=.16*Math.sign(dz);w.userData.noGhost=true;shell.add(w);}
 // 下の詰め物（タイヤの奥が抜けて見えないように）
 
 // タイヤの奥（中の部品が透けて見えないように黒い覆いをかぶせる）
 const wells=new THREE.Group();root.add(wells);const liner=new THREE.MeshBasicMaterial({color:0x08090b,side:THREE.DoubleSide}),linerG=new THREE.CylinderGeometry(arch-.006,arch-.006,.3,36,1,true,Math.PI/2,Math.PI);for(const wxp of D.wx)for(const zs of[1,-1]){const q=new THREE.Mesh(linerG,liner);q.rotation.x=Math.PI/2;q.position.set(wxp,wy,zs*(Wd(wxp)-.2));wells.add(q);const bk=new THREE.Mesh(new THREE.CircleGeometry(arch,36,0,Math.PI),liner);bk.position.set(wxp,wy-.002,zs*(Wd(wxp)-.33));wells.add(bk);}
 // タイヤ
 const wheels=[];for(const wxp of D.wx)for(const s of[1,-1]){wheels.push(wheel(D.r,.21,{parent:root,at:[wxp,D.r,s*(Wd(wxp)-.115)],side:s,rim:o.rim,tire:o.tire}));}
 // ===== 車の中 =====
 const seatC=o.seat||'#8a8e93',matC=o.mat||'#4b4f56',trim=o.trim||'#6a6e74',seatM=surface('cloth',{color:seatC,scale:.9}),seatIn=surface('cloth',{color:new THREE.Color(seatC).multiplyScalar(.82).getStyle(),scale:1.1}),carpet=surface('cloth',{color:matC,scale:.55,bump:.02}),trimM=std({color:trim,roughness:.75,envMapIntensity:.5}),darkM=std({color:'#2f3137',roughness:.55,envMapIntensity:.6});
 const inMats=[seatM,seatIn,carpet,trimM,darkM];for(const m of inMats){m.emissive=m.color.clone();m.emissiveIntensity=0;}
 const floorY=.36+(D.r-.325),w0=Wd(0)-.1,fx=D.frontSeat,rx=D.rearSeat,dX=D.xA-.34,cg=D.cargo,rf=D.roof;
 const cA=(g,m,x,y,z,name,par=cabin)=>{const q=new THREE.Mesh(g,m);q.position.set(x,y,z);q.castShadow=q.receiveShadow=true;if(name)q.name=name;par.add(q);return q;};
 cA(new RoundedBoxGeometry(xe-xs-.9,.03,w0*2,2,.01),carpet,(xs+xe)/2-.1,floorY-.015,0,'床のじゅうたん');
 // 足元のマット（ここがよく汚れる場所として見せやすい）
 const matG=new RoundedBoxGeometry(.56,.018,.54,2,.006),matRim=new RoundedBoxGeometry(.6,.012,.58,2,.004),matS=[];for(const[x,z]of[[fx+.42,.4],[fx+.42,-.4],[rx+.46,.4],[rx+.46,-.4]]){cA(matRim,darkM,x,floorY+.006,z);matS.push(cA(matG,carpet,x,floorY+.012,z,'足元のマット'));}
 // センターのふくらみ
 cA(pillowGeo(1.4,.1,.26,.04,.01),carpet,(fx+rx)/2+.12,floorY+.045,0,'床のじゅうたん');cA(new RoundedBoxGeometry(.72,.22,.2,3,.04),trimM,fx+.34,floorY+.14,0,'真ん中の物入れ');
 // ドアの内側
 const dx0=D.cx-.1,dx1=D.xA-.25,dTop=T(0)-.13,dBot=floorY+.08;for(const s of[1,-1]){cA(new RoundedBoxGeometry(dx1-dx0,dTop-dBot,.05,3,.02),trimM,(dx0+dx1)/2,(dTop+dBot)/2,s*(w0+.02),'ドアの内側',shell);cA(pillowGeo(.48,.05,.09,.02,.005),seatM,fx+.26,floorY+.4,s*(w0-.02),'ドアの内側',shell);cA(pillowGeo(.44,.05,.09,.02,.005),seatM,rx+.2,floorY+.4,s*(w0-.02),'ドアの内側',shell);
  cA(new RoundedBoxGeometry(dx1-dx0,.03,.06,2,.01),darkM,(dx0+dx1)/2,dTop+.01,s*(w0+.01),'ドアの内側',shell);}
 // ダッシュボードとハンドル（日本の車は右ハンドル）
 cA(pillowGeo(.36,.14,w0*2-.04,.06,.015,1),darkM,dX+.02,T(dX)-.1,0,'ダッシュボード');cA(new RoundedBoxGeometry(.3,.26,w0*1.1,3,.05),trimM,dX-.02,floorY+.3,0);cA(new RoundedBoxGeometry(.02,.1,.24,2,.008),std({color:'#07090c',roughness:.12,metalness:.4}),dX-.14,T(dX)+.02,0,'画面').rotation.z=.25;
 const sw=new THREE.Group();sw.position.set(dX-.27,T(dX)-.08,.38);sw.rotation.z=.42;cabin.add(sw);const swR=new THREE.Mesh(new THREE.TorusGeometry(.165,.017,12,48).rotateY(Math.PI/2),darkM);swR.castShadow=true;swR.name='ハンドル';sw.add(swR);sw.add(new THREE.Mesh(new RoundedBoxGeometry(.04,.13,.13,3,.018),darkM));for(const a of[Math.PI/2,-Math.PI/2,Math.PI]){const q=new THREE.Mesh(new THREE.BoxGeometry(.012,.15,.028),trimM);q.position.set(0,Math.cos(a)*.08,Math.sin(a)*.08);q.rotation.x=-a;sw.add(q);}
 // 座席
 const seat=(w,heads,x,z)=>{const g=new THREE.Group();g.position.set(x,floorY+.22,z);cabin.add(g);g.name='座席';const c=(geo,m,xx,yy,zz,par=g)=>{const q=new THREE.Mesh(geo,m);q.position.set(xx,yy,zz);q.castShadow=q.receiveShadow=true;q.name='座席';par.add(q);return q;};
  c(new RoundedBoxGeometry(.46,.2,w*.94,3,.03),darkM,-.01,-.12,0);c(pillowGeo(.5,.1,w*.56,.04,.024),seatIn,0,.02,0);for(const s of[-1,1])c(pillowGeo(.52,.13,w*.22,.055,.012),seatM,0,.035,s*w*.39);
  const bk=new THREE.Group();bk.position.set(-.24,.05,0);bk.rotation.z=.2;g.add(bk);c(pillowGeo(.09,.52,w*.56,.03,.018,0),seatIn,0,.29,0,bk);for(const s of[-1,1])c(pillowGeo(.13,.56,w*.22,.045,.01,0),seatM,-.005,.29,s*w*.39,bk);
  const metalInt=std({color:'#aab1b8',metalness:1,roughness:.3});for(const hz of heads){c(pillowGeo(.09,.15,.24,.04,.012,0),seatM,-.01,.67,hz,bk);for(const s of[-1,1])c(new THREE.CylinderGeometry(.006,.006,.1,8),metalInt,-.01,.58,hz+s*.06,bk);}return g;};
 const sw0=Math.min(.56,w0*.72);for(const z of[-w0*.5,w0*.5])seat(sw0,[0],fx,z);seat(w0*1.8,[-w0*.52,0,w0*.52],rx,0);
 // 荷室
 cA(new RoundedBoxGeometry(.72,.24,w0*2-.02,3,.02),carpet,cg,floorY+.12,0,'荷室の床');
 // 中の灯り（透かしたときだけ）
 const cabL1=new THREE.PointLight('#fff0dc',0,2.4,1.6),cabL2=new THREE.PointLight('#fff0dc',0,2.4,1.6);cabL1.position.set(fx+.2,rf-.18,0);cabL2.position.set(rx-.1,rf-.18,0);root.add(cabL1,cabL2);
 blob([at[0],.006,at[2]],(xe-xs)*.64,Wd(0)*1.42,o.shadow??.58);
 // 使いやすい場所の名前（場所はどれも車の中の点）
 const LOC={front_mat_r:[fx+.42,floorY+.024,.4],front_mat_l:[fx+.42,floorY+.024,-.4],rear_mat_r:[rx+.46,floorY+.024,.4],rear_mat_l:[rx+.46,floorY+.024,-.4],rear_floor:[rx+.46,floorY+.024,0],seat_front_r:[fx,floorY+.3,w0*.5],seat_front_l:[fx,floorY+.3,-w0*.5],seat_rear:[rx,floorY+.3,0],seat_back_rear:[rx-.32,floorY+.62,0],cargo:[cg,floorY+.26,0],dash:[dX,T(dX),0],handle:[dX-.27,T(dX)-.08,.38],center:[(fx+rx)/2,floorY+.5,0],roof:[-.4,rf,0],hood:[(D.xA+xe)/2+.05,T((D.xA+xe)/2)+.02,0],door_r:[(fx+rx)/2,floorY+.34,w0+.03],door_l:[(fx+rx)/2,floorY+.34,-w0-.03],wheel_front:[D.wx[0],D.r,Wd(D.wx[0])],wheel_rear:[D.wx[1],D.r,Wd(D.wx[1])],window:[(D.bx+D.cx)/2,(T(0)+D.roof)/2,Wd(0)-.06],nose:[front,faceY,0],tail:[rear,(T(rear)+Bt(rear))/2,0]};
 const spot=name=>{const a=LOC[name];if(!a)bad('car.spot','場所は '+Object.keys(LOC).join(' / '));root.updateMatrixWorld(true);const p=V(...a).applyMatrix4(root.matrixWorld);return[p.x,p.y,p.z];};
 const hg=o.lights!==true?null:[1,-1].map(zs=>glow([at[0]+front-.16,at[1]+T(front-.16)-.13,at[2]+zs*(Wd(front-.16)-.09)],.42,'#fff1d0',.42));
 let xr=null;const api={group:root,shell,cabin,wheels,length:xe-xs,height:rf,spot,spots:Object.keys(LOC),paint,
  // 透かす。a=0 ふつう、a=1 外側は輪郭だけになって中が見える
  see(a,oo={}){if(!xr)xr=xray(shell,{color:oo.color||o.ghost});const k=clamp(a);xr.set(k);wells.visible=k<.03;cabL1.intensity=k*(oo.light??1.4);cabL2.intensity=k*(oo.light??1.4);for(const m of inMats)m.emissiveIntensity=k*(oo.glow??.34);if(hg)hg.forEach(q=>q.set(1-k));return this;}};return api;}

// ===== 家：屋根・壁・窓のある形（前は +z）=====
function house(o={}){const w=o.w||7,d=o.d||6,h=o.h||2.7,rh=o.rh||w*.24,at=o.at||[0,0,0];const root=group({at,rot:o.rot,name:o.name||'家',parent:o.parent}),shell=group({parent:root,name:'家の外側'});
 const wallM=o.wallMat||surface(o.wall2||'plaster',{color:o.wall||'#d7d2c6',scale:.7}),roofM=o.roofMat||std({map:tex(256,(g,s)=>{g.fillStyle='#e8e8e8';g.fillRect(0,0,s,s);for(let y=0;y<16;y++){g.fillStyle=y%2?'#9a9a9a':'#b4b4b4';g.fillRect(0,y*s/16,s,2.5);for(let x=0;x<14;x++){g.fillStyle='#8a8a8a';g.fillRect(x*s/14+(y%2?s/28:0),y*s/16,1.6,s/16);}}},2.5,2.5),color:o.roof||'#5a6068',roughness:.72,envMapIntensity:.55});
 const add=(g,m,x,y,z,na,par=shell)=>{const q=new THREE.Mesh(g,m);q.position.set(x,y,z);q.castShadow=q.receiveShadow=true;if(na)q.name=na;par.add(q);return q;};
 const fh=.32,base=surface('concrete',{color:'#8d8c86'});add(new THREE.BoxGeometry(w+.06,fh,d+.06),base,0,fh/2,0,'基礎');
 const t=.12;add(new THREE.BoxGeometry(w,h,t),wallM,0,fh+h/2,d/2-t/2,'壁');add(new THREE.BoxGeometry(w,h,t),wallM,0,fh+h/2,-d/2+t/2,'壁');add(new THREE.BoxGeometry(t,h,d),wallM,w/2-t/2,fh+h/2,0,'壁');add(new THREE.BoxGeometry(t,h,d),wallM,-w/2+t/2,fh+h/2,0,'壁');
 const gab=new THREE.ExtrudeGeometry(new THREE.Shape([[-w/2,0],[w/2,0],[0,rh]].map(a=>new THREE.Vector2(a[0],a[1]))),{depth:t,bevelEnabled:false});add(gab,wallM,0,fh+h,d/2-t,'壁');add(gab,wallM,0,fh+h,-d/2,'壁');
 const ov=.42,slope=Math.hypot(w/2+ov,rh+ov*rh/(w/2)),ang=Math.atan2(rh,w/2),roofG=new THREE.BoxGeometry(slope,.12,d+ov*2);for(const s of[1,-1]){const q=add(roofG,roofM,s*(w/2+ov)/2,fh+h+rh/2-.02,0,'屋根');q.rotation.z=-s*ang;}
 add(new THREE.BoxGeometry(.2,.1,d+ov*2+.02),std({color:'#3c4046',roughness:.5,metalness:.4}),0,fh+h+rh+.04,0,'屋根');
 const frame=std({color:'#3a3f46',roughness:.5,metalness:.3}),gl=new THREE.MeshPhysicalMaterial({color:'#223441',roughness:.06,metalness:.7,envMapIntensity:1.4});
 const win=(x,y,z,ww,hh,ry=0)=>{const gp=new THREE.Group();gp.position.set(x,y,z);gp.rotation.y=ry;gp.name='窓';shell.add(gp);const pane=new THREE.Mesh(new THREE.BoxGeometry(ww,hh,.03),gl);pane.name='窓';gp.add(pane);for(const dy of[-hh/2,hh/2]){const b=new THREE.Mesh(new THREE.BoxGeometry(ww+.1,.06,.08),frame);b.position.y=dy;gp.add(b);}for(const dx of[-ww/2,0,ww/2]){const b=new THREE.Mesh(new THREE.BoxGeometry(.05,hh,.07),frame);b.position.x=dx;gp.add(b);}};
 win(-w*.27,fh+h*.56,d/2+.01,1.6,1.2);win(w*.3,fh+h*.56,d/2+.01,1.1,1.2);win(w/2+.01,fh+h*.56,0,1.5,1.1,Math.PI/2);win(-w/2-.01,fh+h*.56,-d*.2,1.5,1.1,Math.PI/2);
 const doorM=wood({base:'#6b4a2e',late:'#47301c',rings:9,scale:1.6,along:'y'});const door=add(new THREE.BoxGeometry(.92,2,.05),doorM,w*.03,fh+1,d/2+.01,'玄関');add(new THREE.BoxGeometry(1.5,.1,.9),std({color:'#3c4046',roughness:.6}),w*.03,fh+2.2,d/2+.4,'玄関');add(new THREE.BoxGeometry(1.4,.18,.8),base,w*.03,.09,d/2+.42,'玄関');
 blob([at[0],.006,at[2]],(w+.6)*.68,(d+.6)*.68,o.shadow??.5);
 const inner=group({parent:root,name:'家の中'});let xr=null;return{group:root,shell,inner,w,d,h,fh,roofY:fh+h+rh,see(a,oo={}){if(!xr)xr=xray(shell,{color:oo.color});xr.set(a);return this;}};}

// ===== 入れ物：薬剤・塗料・水など（文字は職人が言った言葉だけ）=====
function bottle(o={}){const h=o.h||.34,r=o.r||.085,g=group({at:o.at,rot:o.rot,name:o.name||'入れ物',scale:o.scale,parent:o.parent}),m=new THREE.MeshPhysicalMaterial({color:color(o.color||'#e9f3f4'),roughness:.26,clearcoat:.8,clearcoatRoughness:.12,envMapIntensity:1.2});
 const p=[[0,0],[r*.84,0],[r*.98,h*.03],[r,h*.08],[r,h*.6],[r*.94,h*.7],[r*.62,h*.8],[r*.42,h*.84],[r*.4,h*.92],[0,h*.92]].map(a=>new THREE.Vector2(a[0],a[1])),b=new THREE.Mesh(new THREE.LatheGeometry(p,48),m);b.castShadow=b.receiveShadow=true;b.name=g.name;g.add(b);
 const cap=new THREE.Mesh(new THREE.CylinderGeometry(r*.44,r*.46,h*.12,28),std({color:o.cap||'#1b6d6a',roughness:.4}));cap.position.y=h*.96;cap.castShadow=true;g.add(cap);
 if(o.text){const lines=String(o.text).split('\n').slice(0,3),c=tex(512,(q,s)=>{q.fillStyle=o.labelColor||'#f8fbfb';q.fillRect(0,0,s,s);q.fillStyle=o.cap||'#1b6d6a';q.fillRect(0,0,s,26);q.fillRect(0,s-26,s,26);q.fillStyle='#10292c';q.textAlign='center';q.textBaseline='middle';const fs=Math.min(96,Math.floor(430/Math.max(...lines.map(l=>l.length))));q.font=`800 ${fs}px ${FONT}`;lines.forEach((l,i)=>q.fillText(l,s/2,s/2+(i-(lines.length-1)/2)*fs*1.3));});c.wrapS=c.wrapT=THREE.ClampToEdgeWrapping;const lab=new THREE.Mesh(new THREE.CylinderGeometry(r*1.006,r*1.006,h*.42,48,1,true,-Math.PI*.42,Math.PI*.84),std({map:c,roughness:.55,envMapIntensity:.5}));lab.position.y=h*.34;lab.name=g.name;g.add(lab);}
 blob([0,.004,0],r*2.1,r*2.1,.5,{parent:g});return g;}
