"use strict";

// A larger, made-up history: a proto-language and a daughter derived by ordered sound laws (h lost,
// prothesis before s+stop, monophthongization, palatalization before front vowels, nasal + stop > voiced
// stop, intervocalic voicing and spirantization, suffix erosion, o > u before n, rt > tr, syncope). The
// laws are known, so the checks say whether the comparison finds them. Run with: node test/sound-laws.js

const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'laws-'));
const assert = require('node:assert');
const R = '../lib/';
const dict=require(R+'dictionary'),phon=require(R+'phonology'),corr=require(R+'correspondences');

// ---- a seeded generator ----
let seed=12345;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff};
const pick=a=>a[Math.floor(rnd()*a.length)];
const C=['p','t','k','b','d','g','m','n','s','h','r','l','w','j'], V=['a','e','i','o','u'], D=['ai','au','ei'];
const SUF=['','','','ana','ta','ki','mo','ni'];
const roots=new Set();
while(roots.size<85){
  const syl=()=>pick(C)+(rnd()<0.18?pick(D):pick(V));
  let w=syl()+(rnd()<0.25?pick(['m','n'])+pick(['p','t','k']):pick(C))+syl();
  if(rnd()<0.2) w='s'+pick(['k','t','p'])+pick(V)+pick(C)+pick(V);
  if(rnd()<0.1) w=pick(C)+pick(V)+pick(['rt','lt','rk'])+pick(V);
  roots.add(w+pick(SUF));
}
const words=[...roots];

// ---- sound laws, in order ----
const V_='[aeiou]';
const laws=[
 w=>w.replace(/h/g,''),                                       // h lost
 w=>w.replace(/sk|st|sp/g,m=>'e'+m).replace(/^e(?=s[ktp])/, 'e'),                 // prothesis before sC (all positions, fine for initial)
 w=>w.replace(/ai(?!r)/g,'e').replace(/au/g,'o').replace(/ei/g,'i'),     // monophthongization
 w=>w.replace(/k(?=[ie])/g,'ch'),                                   // palatalization
 w=>w.replace(/m(?=p)p/g,'b').replace(/n(?=t)t/g,'d').replace(/n(?=k)k/g,'g'), // nasal + voiceless stop > voiced stop
 w=>w.replace(new RegExp(`(${V_})b(?=${V_})`,'g'),'$1v').replace(new RegExp(`(${V_})d(?=${V_})`,'g'),'$1dh').replace(new RegExp(`(${V_})g(?=${V_})`,'g'),'$1gh'),
 w=>w.replace(new RegExp(`(${V_})p(?=${V_})`,'g'),'$1b').replace(new RegExp(`(${V_})t(?=${V_})`,'g'),'$1d').replace(new RegExp(`(${V_})k(?=${V_})`,'g'),'$1g'),
 w=>w.replace(/ana$/,'a').replace(/(ta|ki|mo|ni)$/,m=>(w.length>7?'':m)), // suffix erosion in long words
 w=>w.replace(/on/g,'un'),                                      // raising before n
 w=>w.replace(/rt/g,'tr'),                                      // metathesis
];
const derive=w=>laws.reduce((x,f)=>f(x),w);
// syncope: 2nd-syllable vowel lost between single consonants in 3+ syllable words (after the rest)
const syncope=w=>{const m=w.match(/^([^aeiou]*[aeiou]+)([^aeiou])([aeiou])([^aeiou])([aeiou].*)$/);return m&&/[aeiou]/.test(m[5])?m[1]+m[2]+m[4]+m[5]:w};

const proto=dict.createLanguage({slug:'p',name:'Proto',is_proto:true}),mod=dict.createLanguage({slug:'m',name:'Modern'});
const oldS=[...C,...V], P=x=>({ipa:x}), G=(g,i)=>({grapheme:g,ipa:i});
phon.savePhonology(proto.id,{phonemes:oldS.map(P),graphemes:oldS.map(x=>G(x,x)),prosody:{show_syllables:true,diphthongs:'ai au ei',max_coda:1}});
const newS=['p','t','k','b','d','g','m','n','s','r','l','w','j','tʃ','v','ð','ɣ',...V];
const newSp=[...['p','t','k','b','d','g','m','n','s','r','l','w','j','v',...V].map(x=>G(x,x)),G('ch','tʃ'),G('dh','ð'),G('gh','ɣ')];
phon.savePhonology(mod.id,{phonemes:newS.map(P),graphemes:newSp,prosody:{show_syllables:true,diphthongs:'ai',max_coda:1}});
const pairs=[];
for(const w of words){let d=derive(w);d=syncope(d);pairs.push([w,d]);}
// a few hand-made irregular cases
pairs.push(['kartu','katru'],['haina','aina'],['saimo','sema'],['tautu','totu'],['pamba','paba'],['kenta','kenda']);
for(const [o,n] of pairs){
  try{const a=dict.saveWord(null,proto.id,{headword:o,senses:['x'],pos:'noun'});dict.saveWord(null,mod.id,{headword:n,senses:['x'],pos:'noun',ancestors:[{id:a,kind:'inherited'}]});}catch(e){console.log('skip',o,n,e.message)}
}
const r=corr.correspond(proto.id,mod.id);
const flow=(from,to)=>r.flows.find(f=>f.from===from&&f.to===to);
const named=(from,to,text)=>{const f=flow(from,to);assert.ok(f,`${from} > ${to} is found`);assert.ok(f.processes.some(p=>p.includes(text)),`${from} > ${to}: ${f.processes.join('; ')} should mention ${text}`);return f;};

assert.strictEqual(r.skipped,0);
named('h','∅','h-dropping');
named('∅','e','prothesis');
named('ai','e','monophthongization');
named('au','o','monophthongization');
named('ei','i','monophthongization');
named('k','tʃ','palatalization');
named('na','∅','loss of a final syllable');
named('mo','∅','loss of a final syllable');
named('rt','tr','metathesis');
named('b','v','spirantization');
named('t','d','voicing');
assert.ok(flow('nt','d')||flow('nt','ð'),'nasal + stop is one coalescence');
assert.ok(!r.flows.some(f=>f.from==='n'&&f.to==='∅'),'the n of -ana is not picked apart from its syllable');
assert.ok(!r.flows.some(f=>/degemination/.test(f.processes.join())),'no vowel is called a degemination');
const palatal=r.conditions.find(c=>c.from==='k'&&c.to==='tʃ');
assert.ok(palatal&&palatal.what==='a front vowel'&&palatal.hits>=25,'k > tʃ before front vowels is found');
const voicing=r.conditions.find(c=>c.from==='t'&&c.to==='d');
assert.ok(voicing&&voicing.side==='both'&&voicing.what==='between vowels','t > d between vowels is found');
assert.ok(r.shape.lostSyllables.some(x=>x.text==='na'&&x.position==='final'&&x.count>=10),'the eroded suffix is listed');
assert.ok(r.shape.whyShorter[0].cause==='a whole syllable was lost');
console.log('ok   a made-up history of '+r.used+' word pairs: its sound laws are found, and named sensibly');
