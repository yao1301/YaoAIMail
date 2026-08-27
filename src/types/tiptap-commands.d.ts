import "@tiptap/core";

// 手动补充 Tiptap 字体/图片命令的类型声明（扩展包类型增强未生效时的兜底）
declare module "@tiptap/core" {
  interface ChainedCommands {
    setFontFamily: (fontFamily: string) => this;
    unsetFontFamily: () => this;
    setImage: (options: { src: string; alt?: string; title?: string }) => this;
  }
}
