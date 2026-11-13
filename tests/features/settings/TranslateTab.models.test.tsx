import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TranslateTab from "../../../src/features/settings/TranslateTab";
import zh from "../../../src/locales/zh.json";

const mocks = vi.hoisted(() => ({
  getTranslateConfig: vi.fn(), saveTranslateConfig: vi.fn(), testTranslateConnection: vi.fn(), getGlobalProxy: vi.fn(), updateGlobalProxy: vi.fn(),
}));
vi.mock("../../../src/lib/api", () => mocks);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key.split(".").reduce((value: any, part) => value?.[part], zh) ?? key }),
}));

const provider = (id: string, kind = "deepseek", model = "vendor-custom-model") => ({
  id, name: kind === "custom" ? "My endpoint" : kind === "deepseek" ? "DeepSeek" : "OpenAI",
  kind, model, api_key: `example-key-${id}`, base_url: "https://api.example.com", chat_path: "/chat/completions", mode: "completions", use_proxy: false,
});
let saved: any;
beforeEach(() => {
  vi.clearAllMocks();
  saved = { provider_type: "llm", is_enabled: true, config: JSON.stringify({ type: "llm", active_id: "existing", providers: [provider("existing")] }) };
  mocks.getTranslateConfig.mockImplementation(async () => saved);
  mocks.saveTranslateConfig.mockImplementation(async (provider_type, config, is_enabled) => { saved = { provider_type, config, is_enabled }; });
  mocks.testTranslateConnection.mockResolvedValue("OK");
  mocks.getGlobalProxy.mockResolvedValue({host:"127.0.0.1",port:11001});
  mocks.updateGlobalProxy.mockResolvedValue(undefined);
});

describe("AI model configuration", () => {
  it("keeps each model proxy choice separate and uses it for testing, saving and reloading",async()=>{
    render(<TranslateTab/>);
    fireEvent.change(await screen.findByLabelText("模型 ID"),{target:{value:"unsaved-model-fixture"}});
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox',{name:'使用代理',exact:true}));
    fireEvent.change(screen.getByLabelText("当前大模型"),{target:{value:'preset_gemini'}});
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("当前大模型"),{target:{value:'existing'}});
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(true);
    mocks.testTranslateConnection.mockResolvedValue("你好");
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}));
    await waitFor(()=>expect(mocks.testTranslateConnection).toHaveBeenCalled());
    const tested=JSON.parse(mocks.testTranslateConnection.mock.calls[0][0]);
    expect(tested.providers.find((p:any)=>p.id==='existing').use_proxy).toBe(true);
    expect((await screen.findByRole('status')).textContent).toBe('连接成功');
    expect(screen.queryByText('你好')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));
    await waitFor(()=>expect(mocks.saveTranslateConfig).toHaveBeenCalled());
    expect(JSON.parse(saved.config).providers.find((p:any)=>p.id==='existing').use_proxy).toBe(true);
    expect(JSON.parse(saved.config).providers.find((p:any)=>p.id==='preset_gemini').use_proxy).toBe(false);
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("unsaved-model-fixture");
    expect(mocks.updateGlobalProxy).not.toHaveBeenCalled();
  });
  it("preserves legacy proxy behavior without choosing by vendor name",async()=>{
    const legacy:any=provider('existing'); delete legacy.use_proxy;
    saved.config=JSON.stringify({type:'llm',active_id:'existing',providers:[legacy]});
    const view=render(<TranslateTab/>);
    await screen.findByLabelText('模型 ID');
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox',{name:'使用代理',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));
    await waitFor(()=>expect(mocks.saveTranslateConfig).toHaveBeenCalled());
    view.unmount(); render(<TranslateTab/>);
    await screen.findByLabelText('模型 ID');
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'测试连接'}));
    await waitFor(()=>expect(mocks.testTranslateConnection).toHaveBeenCalled());
    expect(JSON.parse(mocks.testTranslateConnection.mock.calls[0][0]).providers[0].use_proxy).toBe(false);
  });
  it("preserves local HTTP through test, save and reload, and warns about plaintext", async () => {
    saved.config = JSON.stringify({ type: "llm", active_id: "custom", providers: [{...provider("custom", "custom"), base_url: "http://192.168.20.2:18080/v1", chat_path: ""}] });
    const view = render(<TranslateTab />);
    const input = await screen.findByLabelText("完整接口地址");
    expect((input as HTMLInputElement).value).toBe("http://192.168.20.2:18080/v1/chat/completions");
    expect(screen.getByRole("note").textContent).toContain("HTTP 不加密");
    fireEvent.click(screen.getByRole("button", {name: "测试连接"}));
    await waitFor(() => expect(mocks.testTranslateConnection).toHaveBeenCalled());
    expect(JSON.parse(mocks.testTranslateConnection.mock.calls[0][0]).providers[0].base_url).toBe("http://192.168.20.2:18080/v1/chat/completions");
    fireEvent.click(screen.getByRole("button", {name: "保存"}));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalled());
    view.unmount(); render(<TranslateTab />);
    expect((await screen.findByLabelText("完整接口地址") as HTMLInputElement).value).toBe("http://192.168.20.2:18080/v1/chat/completions");
  });
  it("does not require a proxy for legacy configurations when none was previously configured", async () => {
    mocks.getGlobalProxy.mockResolvedValue(null);
    const legacy:any=provider('existing'); delete legacy.use_proxy;
    saved.config=JSON.stringify({type:'llm',active_id:'existing',providers:[legacy]});
    render(<TranslateTab/>);
    await screen.findByLabelText('模型 ID');
    expect((screen.getByRole('checkbox',{name:'使用代理',exact:true}) as HTMLInputElement).checked).toBe(false);
  });
  it("shows the shared enable switch and built-ins directly, with only custom Add", async () => {
    render(<TranslateTab />);
    await screen.findByLabelText("模型 ID");
    expect((screen.getByRole("checkbox", { name: "启用翻译/AI大模型" }) as HTMLInputElement).checked).toBe(true);
    const picker = screen.getByLabelText("当前大模型");
    expect(within(picker).getByRole("option", { name: "DeepSeek", exact: true })).toBeTruthy();
    expect(within(picker).getByRole("option", { name: "OpenAI", exact: true })).toBeTruthy();
    expect(within(picker).getByRole("option", { name: "Google Gemini", exact: true })).toBeTruthy();
    expect(within(picker).queryByRole("option", { name: /添加/ })).toBeNull();
    expect(within(picker).getByRole("option", { name: "＋ 新增自定义模型" })).toBeTruthy();
    expect(mocks.saveTranslateConfig).not.toHaveBeenCalled();
  });

  it("tests, saves and reloads a preset model ID outside the suggestion list", async () => {
    let view = render(<TranslateTab />);
    const input = await screen.findByLabelText("模型 ID");
    expect((input as HTMLInputElement).value).toBe("vendor-custom-model");
    fireEvent.change(input, { target: { value: "vendor-new-model-id" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(mocks.testTranslateConnection).toHaveBeenCalled());
    expect(JSON.parse(mocks.testTranslateConnection.mock.calls[0][0]).providers[0].model).toBe("vendor-new-model-id");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalled());
    const stored = JSON.parse(saved.config);
    expect(stored.active_id).toBe("existing");
    expect(stored.providers[0]).toEqual({ ...provider("existing"), model: "vendor-new-model-id" });
    view.unmount();
    view = render(<TranslateTab />);
    expect((await screen.findByLabelText("模型 ID") as HTMLInputElement).value).toBe("vendor-new-model-id");
  });

  it("preserves old duplicate profiles and custom IDs when switching providers", async () => {
    const profiles = [provider("existing"), provider("second", "deepseek", "other-id"), provider("custom", "custom", "custom-id")];
    saved.config = JSON.stringify({ type: "llm", active_id: "existing", providers: profiles });
    render(<TranslateTab />);
    await screen.findByLabelText("模型 ID");
    fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "first-edited-id" } });
    fireEvent.change(screen.getByLabelText("当前大模型"), { target: { value: "second" } });
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("other-id");
    fireEvent.change(screen.getByLabelText("当前大模型"), { target: { value: "existing" } });
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("first-edited-id");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalled());
    const stored = JSON.parse(saved.config);
    expect(stored.providers.filter((p: any) => p.kind === "deepseek")).toHaveLength(2);
    expect(stored.providers.find((p: any) => p.id === "second")).toEqual(profiles[1]);
    expect(stored.providers.find((p: any) => p.id === "custom").model).toBe("custom-id");
  });

  it("provides presets for first use and still allows adding custom endpoints", async () => {
    saved = null;
    render(<TranslateTab />);
    await waitFor(() => expect(mocks.getTranslateConfig).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("服务商"), { target: { value: "llm" } });
    expect(within(screen.getByLabelText("当前大模型")).getAllByRole("option")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("当前大模型"), { target: { value: "__add_custom" } });
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("新增模型 ID"), { target: { value: "my-custom-model" } });
    fireEvent.click(screen.getByRole('button', { name: '确认模型 ID' }));
    expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("my-custom-model");
  });

  it('adds and switches IDs under one custom provider while preserving credentials and endpoint', async () => {
    saved.config = JSON.stringify({ type: 'llm', active_id: 'custom', providers: [{ ...provider('custom', 'custom', 'model-basic'), base_url: 'https://api.example.test/v1/chat/completions', chat_path: '', use_proxy: true }] });
    const view = render(<TranslateTab />);
    const picker = await screen.findByLabelText('模型 ID');
    expect((picker as HTMLSelectElement).value).toBe('model-basic');
    fireEvent.change(picker, { target: { value: '__add_model_id' } });
    fireEvent.change(screen.getByLabelText('新增模型 ID'), { target: { value: ' model-advanced ' } });
    expect((screen.getByRole('button', { name: '保存', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认模型 ID' }));
    expect((picker as HTMLSelectElement).value).toBe('model-advanced');
    expect((screen.getByLabelText('API Key（必填）') as HTMLInputElement).value).toBe('example-key-custom');
    expect((screen.getByLabelText('完整接口地址') as HTMLInputElement).value).toBe('https://api.example.test/v1/chat/completions');
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalledOnce());
    const custom = JSON.parse(saved.config).providers.filter((p: any) => p.kind === 'custom');
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ model: 'model-advanced', models: ['model-basic', 'model-advanced'], api_key: 'example-key-custom', use_proxy: true, base_url: 'https://api.example.test/v1/chat/completions' });
    view.unmount(); render(<TranslateTab />);
    const reloaded = await screen.findByLabelText('模型 ID');
    expect((reloaded as HTMLSelectElement).value).toBe('model-advanced');
    fireEvent.change(reloaded, { target: { value: 'model-basic' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(mocks.testTranslateConnection).toHaveBeenCalledOnce());
    const tested = JSON.parse(mocks.testTranslateConnection.mock.calls[0][0]).providers.find((p: any) => p.id === 'custom');
    expect(tested).toEqual({ ...custom[0], model: 'model-basic' });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalledTimes(2));
    expect(JSON.parse(saved.config).providers.find((p: any) => p.id === 'custom').model).toBe('model-basic');
  });

  it('edits an ID without modifying the other saved IDs or provider connection settings', async () => {
    saved.config = JSON.stringify({ type: 'llm', active_id: 'custom', providers: [{ ...provider('custom', 'custom', 'model-a'), models: ['model-a', 'model-b'] }] });
    render(<TranslateTab />);
    await screen.findByLabelText('模型 ID');
    fireEvent.click(screen.getByRole('button', { name: '修改当前模型 ID' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改当前模型 ID' }), { target: { value: 'model-c' } });
    fireEvent.click(screen.getByRole('button', { name: '确认模型 ID' }));
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalledOnce());
    expect(JSON.parse(saved.config).providers[0]).toMatchObject({ id: 'custom', model: 'model-c', models: ['model-c', 'model-b'], api_key: 'example-key-custom', use_proxy: false });
  });

  it('rejects duplicate and empty IDs and cancellation keeps the existing configuration', async () => {
    saved.config = JSON.stringify({ type: 'llm', active_id: 'custom', providers: [{ ...provider('custom', 'custom', 'model-a'), models: ['model-a', 'model-b'] }] });
    render(<TranslateTab />);
    const picker = await screen.findByLabelText('模型 ID');
    fireEvent.change(picker, { target: { value: '__add_model_id' } });
    expect((screen.getByRole('button', { name: '确认模型 ID' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('新增模型 ID'), { target: { value: ' model-b ' } });
    expect(screen.getByRole('alert').textContent).toContain('已存在');
    expect((screen.getByRole('button', { name: '确认模型 ID' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消修改模型 ID' }));
    expect((picker as HTMLSelectElement).value).toBe('model-a');
    expect((screen.getByRole('button', { name: '保存', exact: true }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.saveTranslateConfig).not.toHaveBeenCalled();
  });

  it('migrates a single custom ID and isolates model lists between configurations', async () => {
    saved.config = JSON.stringify({ type: 'llm', active_id: 'custom-a', providers: [provider('custom-a', 'custom', 'model-a'), { ...provider('custom-b', 'custom', 'model-b'), models: ['model-b', 'model-c', ' model-c ', '', null] }] });
    render(<TranslateTab />);
    const picker = await screen.findByLabelText('模型 ID');
    expect(within(picker).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['model-a', '__add_model_id']);
    fireEvent.change(screen.getByLabelText('当前大模型'), { target: { value: 'custom-b' } });
    expect(within(screen.getByLabelText('模型 ID')).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(['model-b', 'model-c', '__add_model_id']);
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'model-c' } });
    fireEvent.change(screen.getByLabelText('当前大模型'), { target: { value: 'custom-a' } });
    expect((screen.getByLabelText('模型 ID') as HTMLSelectElement).value).toBe('model-a');
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(mocks.saveTranslateConfig).toHaveBeenCalledOnce());
    const profiles = JSON.parse(saved.config).providers;
    expect(profiles[0].models).toEqual(['model-a']);
    expect(profiles[1].models).toEqual(['model-b', 'model-c']);
    expect(profiles[1].model).toBe('model-c');
  });
});
