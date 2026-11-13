import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import WorkRoleTab, { getActiveWorkRole } from "@/features/settings/WorkRoleTab";

vi.mock("@/hooks/queries", () => ({
  useAccountsQuery: () => ({ data: [{ id: "account", email: "writer@example.test" }] }),
}));
vi.mock("@/lib/api", () => ({ aiPrompt: vi.fn(), getSentSamples: vi.fn() }));

const storageKey = "yaoaimail-work-roles-v1";
const accountId = "account";

function rolePicker() {
  return screen.getByRole<HTMLSelectElement>("combobox", { name: "选择要编辑的工作角色" });
}

function chooseRole(name: string) {
  const picker = rolePicker();
  const option = within(picker).getByRole<HTMLOptionElement>("option", { name });
  fireEvent.change(picker, { target: { value: option.value } });
}

beforeEach(() => localStorage.removeItem(storageKey));

it("previews presets without creating a saved or active role", () => {
  render(<WorkRoleTab />);
  const picker = rolePicker();
  expect(picker.options[0].text).toBe("综合外贸业务");
  expect(picker.options[picker.options.length - 1].text).toBe("＋ 自定义工作角色");
  chooseRole("订单跟进");
  chooseRole("客户开发");
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(getActiveWorkRole(accountId)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "启用此角色" }));
  expect(getActiveWorkRole(accountId)?.name).toBe("客户开发");
  chooseRole("订单跟进");
  expect(getActiveWorkRole(accountId)?.name).toBe("客户开发");
  fireEvent.click(screen.getByRole("button", { name: "停用角色" }));
  expect(getActiveWorkRole(accountId)).toBeNull();
  expect(within(rolePicker()).getByRole("option", { name: "客户开发" })).toBeTruthy();
  expect(localStorage.getItem(storageKey)).toContain("客户开发");
});

it("keeps a new custom role local to the editor until explicitly saved", () => {
  render(<WorkRoleTab />);
  chooseRole("＋ 自定义工作角色");
  expect(localStorage.getItem(storageKey)).toBeNull();
  chooseRole("综合外贸业务");
  chooseRole("自定义工作角色");
  fireEvent.click(screen.getByRole("button", { name: "只保存" }));
  expect(getActiveWorkRole(accountId)).toBeNull();
  expect(localStorage.getItem(storageKey)).toContain("自定义工作角色");

  fireEvent.click(screen.getByRole("button", { name: "启用此角色" }));
  expect(getActiveWorkRole(accountId)?.name).toBe("自定义工作角色");
});

it("uses the previous saved content of an active role until the edits are saved", () => {
  render(<WorkRoleTab />);
  fireEvent.click(screen.getByRole("button", { name: "启用此角色" }));
  const preferences = screen.getByPlaceholderText("写下你的职位、产品、客户、日常工作和沟通习惯…");
  fireEvent.change(preferences, { target: { value: "先确认规格" } });
  expect(getActiveWorkRole(accountId)?.preferences).not.toBe("先确认规格");

  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect(getActiveWorkRole(accountId)?.preferences).toBe("先确认规格");
});
