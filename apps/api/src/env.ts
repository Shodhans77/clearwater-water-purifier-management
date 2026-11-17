import dotenv from 'dotenv';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const moduleDir=dirname(fileURLToPath(import.meta.url));
dotenv.config({path:resolve(moduleDir,moduleDir.endsWith(join('dist','src'))?'../../../../.env':'../../../.env')});
