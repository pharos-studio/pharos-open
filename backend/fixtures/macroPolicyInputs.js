'use strict';
const NOW=Date.parse('2026-10-12T14:00:00Z');
const source={id:'fed',region:'US',authority:'Federal Reserve',authorityZh:'美联储',timezone:'America/New_York',hosts:['www.federalreserve.gov'],feed:'https://www.federalreserve.gov/feeds/press_monetary.xml',archive:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scope:'公开合成feed，无真实政策事实'};
function feed(count=45,changed=false){return '<rss><channel>'+Array.from({length:count},(_,i)=>{const date=new Date(NOW-i*86400000).toUTCString();return `<item><title>Federal Reserve issues FOMC statement ${i}${changed?' revised':''}</title><link>https://www.federalreserve.gov/newsevents/pressreleases/synthetic-${i}.htm</link><guid>synthetic-${i}</guid><pubDate>${date}</pubDate></item>`;}).join('')+'</channel></rss>';}
module.exports={NOW,source,feed};
