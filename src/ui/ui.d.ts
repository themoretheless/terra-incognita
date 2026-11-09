declare module '*.ui' {
  import type { FormaProperty, FormaRuntimeInstance, FormaSlotMap, Signal } from 'svet-engine/slim';
  export const uiSource: string;
  export default function createFormaView(options?: {
    props?: Record<string, unknown>;
    locale?: string;
    viewModel?: Record<string, FormaProperty<any> | Signal<any>>;
    slots?: FormaSlotMap;
  }): FormaRuntimeInstance;
}
