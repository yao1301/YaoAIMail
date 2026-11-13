import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock('@tauri-apps/api/core',()=>({invoke:h.invoke}));
import {refreshCustomerProfile,getCustomerProfileMail} from '@/lib/api';
beforeEach(()=>h.invoke.mockReset().mockResolvedValue([]));
it('uses the single native refresh with just the saved record ID, not the current selected mail thread',async()=>{
 await refreshCustomerProfile('profile-a');expect(h.invoke).toHaveBeenCalledWith('refresh_customer_profile',{id:'profile-a'});
});
it('loads activity from the same exact profile and account-scoped native correspondence path',async()=>{
 await getCustomerProfileMail('profile-a');expect(h.invoke).toHaveBeenCalledWith('get_customer_profile_mail',{id:'profile-a'});
});
