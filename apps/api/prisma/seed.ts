import '../src/env.js';
import bcrypt from 'bcryptjs';
import {PrismaClient,Role,DeviceKind} from '@prisma/client';
const db=new PrismaClient();
async function main(){
 const customerPassword=process.env.SEED_CUSTOMER_PASSWORD,providerPassword=process.env.SEED_PROVIDER_PASSWORD;
 if(!customerPassword||!providerPassword||customerPassword.length<12||providerPassword.length<12)throw new Error('Set SEED_CUSTOMER_PASSWORD and SEED_PROVIDER_PASSWORD (12+ chars) in .env before seeding.');
 const c=await db.user.upsert({where:{email:'shodhan.s77@gmail.com'},update:{},create:{email:'shodhan.s77@gmail.com',username:'shodhan',passwordHash:await bcrypt.hash(customerPassword,12),role:Role.CUSTOMER}});
 const p=await db.user.upsert({where:{email:'shodhanchinnu45@gmail.com'},update:{},create:{email:'shodhanchinnu45@gmail.com',username:'service-team',passwordHash:await bcrypt.hash(providerPassword,12),role:Role.PROVIDER}});
 let org=await db.organization.findFirst({where:{members:{some:{userId:p.id}}}});if(!org)org=await db.organization.create({data:{name:'ClearWater Service Network',members:{create:{userId:p.id}}}});
 const b1=await db.building.upsert({where:{id:'seed-aqua-heights'},update:{},create:{id:'seed-aqua-heights',name:'Aqua Heights',address:'Demo residential complex',organizationId:org.id}});
 const b2=await db.building.upsert({where:{id:'seed-cedar-residency'},update:{},create:{id:'seed-cedar-residency',name:'Cedar Residency',address:'Demo residential complex',organizationId:org.id}});
 const floors=[];for(let i=1;i<=5;i++)floors.push(await db.floor.upsert({where:{buildingId_label:{buildingId:b1.id,label:`Floor ${String(i).padStart(2,'0')}`}},update:{},create:{buildingId:b1.id,label:`Floor ${String(i).padStart(2,'0')}`}}));
 const cf=await db.floor.upsert({where:{buildingId_label:{buildingId:b2.id,label:'Floor 01'}},update:{},create:{buildingId:b2.id,label:'Floor 01'}});
 await db.device.upsert({where:{deviceId:'CW-REAL-001'},update:{customerId:c.id,organizationId:org.id},create:{deviceId:'CW-REAL-001',name:'Home purifier',kind:DeviceKind.REAL,customerId:c.id,organizationId:org.id}});
 const demos=[['AH-01-F01-P01','Aqua Heights · 01','normal',b1,floors[0]],['AH-01-F02-P02','Aqua Heights · 02','warning',b1,floors[1]],['AH-01-F03-P03','Aqua Heights · 03','offline',b1,floors[2]],['AH-01-F05-P05','Aqua Heights · 05','leakage',b1,floors[4]],['CR-02-F01-P01','Cedar Residency · 01','normal',b2,cf]] as const;
 for(const [deviceId,name,_scenario,building,floor]of demos)await db.device.upsert({where:{deviceId},update:{},create:{deviceId,name,kind:DeviceKind.DEMO,organizationId:org.id,buildingId:building.id,floorId:floor.id}});
 console.log('Seeded customer/provider accounts, two buildings, one shared REAL device row (no telemetry), and five DEMO devices.');console.log('Credentials are the values supplied in the two SEED_* environment variables.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
