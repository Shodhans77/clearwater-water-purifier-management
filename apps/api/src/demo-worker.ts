import './env.js';
import {PrismaClient,DeviceKind,Severity} from '@prisma/client';
const db=new PrismaClient();
const tick=async()=>{
 const demos=await db.device.findMany({where:{kind:DeviceKind.DEMO,active:true}});
 for(const d of demos){
  const i=d.deviceId;
  // The offline scenario intentionally receives no telemetry; the online timeout marks it stale.
  if(i==='AH-01-F03-P03'){if(!await db.alert.findFirst({where:{deviceId:d.id,code:'DEVICE_OFFLINE',resolvedAt:null}}))await db.alert.create({data:{deviceId:d.id,code:'DEVICE_OFFLINE',title:'Device offline',severity:Severity.RED,value:'No demo heartbeat',expected:'Online heartbeat',recommendation:'DEMO scenario: simulated device intentionally offline.'}});continue}
  const now=Date.now(),noise=()=>Math.random();
  let tds=190+noise()*45,ph=7.1+noise()*.35,turbidity=.5+noise()*.8,leakage=false;
  if(i==='AH-01-F02-P02')turbidity=5.4+noise()*1.2;
  if(i==='AH-01-F05-P05')leakage=true;
  const flow=noise()<.25?0:1.3+noise()*1.4,previous=await db.telemetry.findFirst({where:{deviceId:d.id},orderBy:{receivedAt:'desc'}}),cumulative=(previous?.cumulativeLitres||0)+flow/6;
  await db.telemetry.create({data:{deviceId:d.id,deviceTimestamp:new Date(now),tdsPpm:Number(tds.toFixed(1)),ph:Number(ph.toFixed(2)),turbidityNtu:Number(turbidity.toFixed(2)),flowLpm:Number(flow.toFixed(2)),pulseCount:Math.round(flow*450/6),cumulativeLitres:Number(cumulative.toFixed(2)),leakage,temperatureC:Number((22+noise()*4).toFixed(1)),humidityPct:Number((40+noise()*20).toFixed(1)),sensorHealth:{tds:true,ph:true,turbidity:true,flow:true,leakage:true,dht11:true}}});await db.device.update({where:{id:d.id},data:{lastSeen:new Date()}});
  const conditions:any[]=[];
  if(leakage)conditions.push(['LEAK','Leakage detected',Severity.RED,'Leak sensor active','No leakage','Demo scenario: inspect the purifier.']);
  if(turbidity>5)conditions.push(['TURBIDITY','High turbidity',Severity.YELLOW,`${turbidity.toFixed(2)} NTU`,'<= 5 NTU','Demo scenario: inspect the filter.']);
  for(const[code,title,severity,value,expected,recommendation]of conditions){
   if(!await db.alert.findFirst({where:{deviceId:d.id,code,resolvedAt:null}}))await db.alert.create({data:{deviceId:d.id,code,title,severity,value,expected,recommendation}});
  }
 }
};
console.log('Demo simulator active: DEMO records only; physical REAL device is untouched.');
setInterval(()=>tick().catch(console.error),10000);tick().catch(console.error);
process.on('SIGINT',async()=>{await db.$disconnect();process.exit(0)});
