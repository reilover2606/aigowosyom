"use strict";

// Checks lib/polygons.js (the joining of land) against thousands of random
// shapes: a point is inside the joined shape exactly when it is inside one of the
// two shapes joined, whether or not they share exact borders. Run with: npm test

const {union,weld,contains,signedArea}=require('../lib/polygons');
let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
// a random simple polygon: star-shaped around a centre with jittered radius
function blob(cx,cy,r,n){const pts=[];for(let i=0;i<n;i++){const a=i/n*Math.PI*2;const rr=r*(0.45+0.55*rnd());pts.push([cx+Math.cos(a)*rr,cy+Math.sin(a)*rr])}pts.push(pts[0]);return pts}
function distToRing(p,ring){let m=1e9;for(let i=0;i<ring.length-1;i++){const [ax,ay]=ring[i],[bx,by]=ring[i+1];const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy;const t=l?Math.max(0,Math.min(1,((p[0]-ax)*dx+(p[1]-ay)*dy)/l)):0;m=Math.min(m,Math.hypot(p[0]-ax-t*dx,p[1]-ay-t*dy))}return m}
let bad=0,trials=0,multi=0,withHoles=0,samples=0;
for(let k=0;k<3000;k++){
  const A=[blob(50,50,30,6+Math.floor(rnd()*30))],B=[blob(50+(rnd()-0.5)*90,50+(rnd()-0.5)*90,20+rnd()*25,6+Math.floor(rnd()*30))];
  if(rnd()<0.25){const h=blob(50,50,8,8).reverse();A.push(h)} // sometimes A has a hole
  let U;try{U=union(A,B)}catch(e){console.log('threw',e.message);bad++;continue}
  trials++;if(U.length>1)multi++;if(U.some(p=>p.length>1))withHoles++;
  const all=U.flatMap(p=>p);
  for(let s=0;s<60;s++){
    const p=[rnd()*140-20,rnd()*140-20];
    const near=Math.min(...[...A,...B,...all].map(r=>distToRing(p,r)));
    if(near<1e-4)continue;samples++;
    const want=contains(A,p)||contains(B,p);
    const got=U.some(poly=>contains(poly,p));
    if(want!==got){bad++;if(bad<6)console.log('MISMATCH trial',k,'point',p.map(x=>+x.toFixed(2)),'want',want,'got',got,'shapes',U.length);break}
  }
}
console.log('trials',trials,'| result had >1 shape:',multi,'| with holes:',withHoles,'| sample points checked',samples,'| failures',bad);
// the same with rectangles that share exact borders (the snap-together case) and integer coordinates
let bad2=0;for(let k=0;k<2000;k++){
  const w=1+Math.floor(rnd()*6),h=1+Math.floor(rnd()*6),x=Math.floor(rnd()*6),y=Math.floor(rnd()*6);
  const A=[[[0,0],[6,0],[6,6],[0,6],[0,0]]];const B=[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]];
  const U=union(A,B);for(let s=0;s<40;s++){const p=[rnd()*16-4+0.0137,rnd()*16-4+0.0291];if(contains(A,p)||contains(B,p)!==U.some(q=>contains(q,p))){if((contains(A,p)||contains(B,p))!==U.some(q=>contains(q,p))){bad2++;break}}}}
console.log('grid-aligned rectangles (shared edges and corners): failures',bad2);

if (bad || bad2) {
    process.exitCode = 1;
}
