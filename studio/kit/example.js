// ===== 場所：最初に world。光・床・背景はこれで全部入る =====
const {THREE,box,rbox,cyl,group,wood,surface,std,tex,world,stain,go,on,since,until,fade,dust,label,mix} = K;
const w=world('room',{japanese:true,size:4});

// ===== 主役：実物の大きさで作る（ふすま 幅.95 高さ1.8 厚さ.02）=====
const W=.95,H=1.8,CY=H/2+.04;
const panel=group({at:[0,CY,0],name:'ふすま'});

// 敷居：床の溝。物は宙に浮かせない
box(W+.5,.04,.12,wood({base:'#a68258',late:'#7e5e3c',scale:2}),{at:[0,.02,0],name:'敷居'});

// 骨：格子に組んだ細い木
const bone=group({parent:panel,name:'骨'});
const boneWood=wood({base:'#c9a877',late:'#a5825a',rings:22,scale:3});
const boneWoodV=wood({base:'#c9a877',late:'#a5825a',rings:22,scale:3,along:'y'});
for(let i=0;i<3;i++)box(.028,H-.03,.03,boneWoodV,{parent:bone,at:[(i-1)*W/3,0,0],name:'骨'});
for(let i=0;i<11;i++)box(W-.03,.028,.03,boneWood,{parent:bone,at:[0,-H/2+.09+i*(H-.18)/10,0],name:'骨'});

// 縁：いちばん外の枠。角を少し丸めて塗りのつやを出す
const rail=std({color:'#2f2119',roughness:.32,envMapIntensity:.8});
for(const x of[-W/2,W/2])rbox(.04,H+.04,.055,.008,rail,{parent:panel,at:[x,0,0],name:'縁'});
for(const y of[-H/2,H/2])rbox(W,.04,.055,.008,rail,{parent:panel,at:[0,y,0],name:'縁'});

// 紙の層：奥から順に貼る
const sheets=[['shita','#d7ceba'],['shita','#ded6c4'],['shita','#e6dfcf']].map(([ch,c],i)=>{
 const m=surface('paper',{color:c,scale:.4});
 const s=box(W-.04,H-.04,.004,m,{parent:panel,at:[0,0,.02+i*.005],name:'下の紙'});
 return{s,m,base:m.color.clone()};});

// 上の紙：柄はキャンバスに描く
const pat=tex(1024,(g,s)=>{g.fillStyle='#d9d6c8';g.fillRect(0,0,s,s);g.strokeStyle='#9aa391';g.lineWidth=2;
 for(let y=0;y<s+80;y+=80)for(let x=0;x<s+160;x+=160){const ox=(y/80)%2?80:0;g.beginPath();g.arc(x+ox,y,78,Math.PI,0);g.stroke();g.beginPath();g.arc(x+ox,y,50,Math.PI,0);g.stroke();g.beginPath();g.arc(x+ox,y,24,Math.PI,0);g.stroke();}},1,2);
const topM=std({map:pat,color:'#ffffff',roughness:.86,envMapIntensity:.4});
const top=box(W-.04,H-.04,.004,topM,{parent:panel,at:[0,0,.04],name:'上の紙'});

// 引手：丸いくぼみ。ここでふすまだと分かる
const pull=group({parent:top,at:[W/2-.11,-.02,.003],name:'引手'});
cyl(.033,.033,.006,std({color:'#6d5733',roughness:.35,metalness:.7}),{parent:pull,rot:[Math.PI/2,0,0],name:'引手'});
cyl(.024,.024,.008,std({color:'#1c1610',roughness:.6}),{parent:pull,at:[0,0,.001],rot:[Math.PI/2,0,0]});

// はがす古い紙：左の縁を軸に開く
const oldHinge=group({parent:panel,at:[-W/2+.02,0,.05]});
const oldM=surface('paper',{color:'#a99a7b',scale:.4});
box(W-.04,H-.04,.004,oldM,{parent:oldHinge,at:[(W-.04)/2,0,0],name:'古い紙'});

// 見えないもの：のりの湿り（色で表す。image_note を台本に書いてある）
const wet=stain([0,CY,.04],.5,{color:'#6fb2d8',edge:'#cfe9f7',normal:[0,0,1],name:'ぬれている所'});
const specks=dust({at:[.1,CY+.3,.12],n:60,spread:[.35,.5,.05],vel:[.06,-.22,.14],gravity:.14,color:'#e8e0cc',size:.012});

// 名札の点は物の表面に置く（層を分けたあとの、右の端の見えている所）
label('骨',[.42,CY+.324,.016],{on:'ato'});
label('下の紙',[.4,CY-.45,.238],{on:'ato'});
label('上の紙',[.3,CY+.32,.463],{on:'ato'});
label('ぬれている所',[.28,CY+.1,.04],{on:'matsu'});

// ===== 動き（p はスクロールの位置。場面の名前で書く）=====
return function(p,t){
 // 古い紙をはがす：場面 hone の前半で開いて、後半で消す
 const open=go('hone',.05,.5);
 oldHinge.rotation.y=-open*1.9;
 fade(oldHinge,since('hone')*(1-go('hone',.45,.62)));
 specks.set(go('hone',.08,.7)*1.2,on('hone')*(1-go('hone',.7,.95)));
 bone.visible=since('hone')>0&&until('ato')>=0;

 // 下の紙：1枚ずつ貼る。貼った直後はぬれて濃く、待つ間に乾いて明るくなる
 sheets.forEach((a,i)=>{const k=go('shita',.05+i*.3,.28+i*.3);fade(a.s,k);a.s.position.z=.02+i*.005+(1-k)*.16;
  const dry=go('matsu',.1,.9);a.m.color.copy(a.base).multiplyScalar(mix(.72,1,dry));});

 // 見せ場：部屋を暗くして、ぬれている所を浮かび上がらせる。乾くと小さくなる（消し切らない）
 const lit=on('matsu');
 w.dim(1-.6*lit*go('matsu',0,.25));
 wet.set(lit*(1-.55*go('matsu',.35,1)),1-.55*go('matsu',.35,1));

 // 上の紙：最初は見えている／貼る場面で戻る
 const shown=(1-since('hone'))+go('uwa',.1,.75);
 fade(top,Math.min(1,shown));top.position.z=.04+(1-Math.min(1,shown))*.24*since('hone');

 // 最後に層を分けて見せる
 const ex=go('ato',.05,.55);
 sheets.forEach((a,i)=>{a.s.position.z+=ex*(.1+i*.11);});
 top.position.z+=ex*.42;
};
