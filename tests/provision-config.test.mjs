import fs from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateTestConfig} from '../secure-session.js';
test('accept Firebase-issued auth domain for the new test project',()=>{const firebase=JSON.parse(fs.readFileSync('security/firebase-web-config.json','utf8'));assert.equal(validateTestConfig({firebase}).authDomain,'mci2--visanu81.firebaseapp.com');});
test('issued auth domain cannot be reused for a different project',()=>{const firebase=JSON.parse(fs.readFileSync('security/firebase-web-config.json','utf8'));assert.throws(()=>validateTestConfig({firebase:{...firebase,projectId:'mci2-other',databaseURL:'https://mci2-other-default-rtdb.firebaseio.com'}}));});
