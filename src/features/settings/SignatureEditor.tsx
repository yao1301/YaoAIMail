import { useRef } from "react";
import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import FontFamily from "@tiptap/extension-font-family";
import Image from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import { Bold, Italic, Underline as UnderlineIcon, Image as ImageIcon } from "lucide-react";

const FONTS: Array<{ label: string; value: string }> = [
  { label: "默认字体", value: "" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "宋体", value: "SimSun, serif" },
  { label: "黑体", value: "SimHei, sans-serif" },
  { label: "微软雅黑", value: "Microsoft YaHei, sans-serif" },
  { label: "Times New Roman", value: "Times New Roman, serif" },
  { label: "Courier New", value: "Courier New, monospace" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
];

const buttonStyle: React.CSSProperties = {
  width: "28px",
  height: "26px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--color-border)",
  borderRadius: "5px",
  background: "#fff",
  color: "var(--color-text-primary)",
  cursor: "pointer",
  fontSize: "13px",
};

/**
 * 富文本签名编辑器：支持字体、粗体/斜体/下划线、插入图片（base64 内嵌），
 * 内容以 HTML 形式保存。
 */
export default function SignatureEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "签名内容（可包含姓名、职位、电话、公司等）" }),
      TextStyle,
      FontFamily.configure({ types: ["textStyle"] }),
      Image.configure({ inline: true, allowBase64: true }),
      Underline,
    ],
    content: value || "",
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  const states = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      underline: e?.isActive("underline") ?? false,
      fontFamily: e?.getAttributes("textStyle").fontFamily as string | undefined,
    }),
  }) ?? { bold: false, italic: false, underline: false, fontFamily: undefined };

  function pickImage(file: File) {
    if (!editor) return;
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      editor.chain().focus().setImage({ src }).run();
    };
    reader.readAsDataURL(file);
  }

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "6px", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "6px", borderBottom: "1px solid var(--color-border)", flexWrap: "wrap" }}>
        <select
          aria-label="签名字体"
          value={states.fontFamily ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            if (value) {
              editor?.chain().focus().setFontFamily(value).run();
            } else {
              editor?.chain().focus().unsetFontFamily().run();
            }
          }}
          style={{ height: "26px", fontSize: "12px", padding: "0 4px", border: "1px solid var(--color-border)", borderRadius: "5px", background: "#fff", maxWidth: "110px", outline: "none" }}
        >
          {FONTS.map((font) => (
            <option key={font.label} value={font.value}>{font.label}</option>
          ))}
        </select>
        <button
          type="button"
          aria-label="加粗"
          title="加粗"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          style={{ ...buttonStyle, background: states.bold ? "var(--color-bg-secondary)" : "#fff" }}
        >
          <Bold size={13} />
        </button>
        <button
          type="button"
          aria-label="斜体"
          title="斜体"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          style={{ ...buttonStyle, background: states.italic ? "var(--color-bg-secondary)" : "#fff" }}
        >
          <Italic size={13} />
        </button>
        <button
          type="button"
          aria-label="下划线"
          title="下划线"
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          style={{ ...buttonStyle, background: states.underline ? "var(--color-bg-secondary)" : "#fff" }}
        >
          <UnderlineIcon size={13} />
        </button>
        <button type="button" aria-label="插入图片" title="插入图片" onClick={() => fileInputRef.current?.click()} style={buttonStyle}>
          <ImageIcon size={13} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) pickImage(file);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <div style={{ minHeight: "90px", padding: "8px 10px", fontSize: "13px", lineHeight: 1.6 }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
