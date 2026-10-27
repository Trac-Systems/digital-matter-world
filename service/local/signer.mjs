import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveSigner } from '../../committee/signer/service.mjs';

export const serve = serveSigner;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await serve(process.argv[2]);
