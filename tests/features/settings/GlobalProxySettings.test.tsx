import { beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalProxySettings from "../../../src/features/settings/GlobalProxySettings";
const m=vi.hoisted(()=>({load:vi.fn(),mail:vi.fn(),save:vi.fn()}));
vi.mock("@/lib/api",()=>({getGlobalProxy:m.load,getMailProxy:m.mail,saveSharedProxySettings:m.save}));
beforeEach(()=>{cleanup();vi.clearAllMocks();m.load.mockResolvedValue({host:"127.0.0.1",port:11001});m.mail.mockResolvedValue(null);m.save.mockResolvedValue(undefined);});
describe('one shared proxy form',()=>{
  it('shows one address and preserves direct mail unless explicitly checked',async()=>{
    render(<GlobalProxySettings/>);
    await waitFor(()=>expect((screen.getByLabelText('代理端口') as HTMLInputElement).value).toBe('11001'));
    expect(screen.getAllByLabelText('代理地址')).toHaveLength(1);
    expect((screen.getByRole('checkbox',{name:'邮件也使用此代理（通常不需要）'}) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'保存代理设置'}));
    await waitFor(()=>expect(m.save).toHaveBeenCalledWith('127.0.0.1',11001,false));
  });
  it('mail opt-in uses the same saved address, never a second address',async()=>{
    render(<GlobalProxySettings/>);
    const checkbox=screen.getByRole('checkbox',{name:'邮件也使用此代理（通常不需要）'});
    await waitFor(()=>expect((checkbox as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText('代理端口'),{target:{value:'11002'}});
    fireEvent.click(screen.getByRole('button',{name:'保存代理设置'}));
    await waitFor(()=>expect(m.save).toHaveBeenCalledWith('127.0.0.1',11002,true));
  });
  it('does not overwrite unreadable settings',async()=>{
    m.mail.mockRejectedValue(new Error('fixture read failed')); render(<GlobalProxySettings/>);
    expect((await screen.findByRole('alert')).textContent).toContain('fixture read failed');
    expect((screen.getByRole('button',{name:'保存代理设置'}) as HTMLButtonElement).disabled).toBe(true);
    expect(m.save).not.toHaveBeenCalled();
  });
  it('warns before explicitly unifying old differing mail addresses, without auto-saving',async()=>{
    m.mail.mockResolvedValue({host:'127.0.0.1',port:11002}); render(<GlobalProxySettings/>);
    expect((await screen.findByRole('note')).textContent).toContain('保存后将统一');
    expect(m.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox',{name:'启用代理设置'}));
    fireEvent.click(screen.getByRole('button',{name:'保存代理设置'}));
    await waitFor(()=>expect(m.save).toHaveBeenCalledWith(undefined,undefined,false));
  });
});
