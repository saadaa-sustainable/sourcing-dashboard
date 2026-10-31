import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poCadFileError,PO_CAD_MAX_BYTES} from './po-cad';
const file={name:'CAD.pdf',size:100,group:'single_piece',width:'',remark:''};
test('CAD PDF limit matches Standard Cost and rejects unsupported/empty files',()=>{
 assert.equal(poCadFileError(file),null);assert.equal(poCadFileError({...file,size:PO_CAD_MAX_BYTES}),null);
 for(const change of [{name:'CAD.xlsx'},{size:0},{size:PO_CAD_MAX_BYTES+1},{size:1.5}])assert.ok(poCadFileError({...file,...change}));
});
test('CAD groups and full layer width are validated',()=>{
 for(const group of ['single_piece','standard_ratio','ratio_1_1'])assert.equal(poCadFileError({...file,group}),null);
 assert.ok(poCadFileError({...file,group:'toString'}));assert.ok(poCadFileError({...file,group:'full_layer'}));
 assert.ok(poCadFileError({...file,group:'full_layer',width:'-1'}));assert.equal(poCadFileError({...file,group:'full_layer',width:'58.5'}),null);
});
test('CAD filename and remark lengths are bounded',()=>{
 assert.ok(poCadFileError({...file,name:'a'.repeat(260)+'.pdf'}));assert.ok(poCadFileError({...file,remark:'a'.repeat(2001)}));
});
