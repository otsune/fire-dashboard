import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],build:{target:'es2020'},server:{host:'127.0.0.1',port:5173,strictPort:true},preview:{host:'127.0.0.1',port:4173,strictPort:true}});
