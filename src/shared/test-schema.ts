import { z } from 'zod';

const text = z.string().min(1).max(2_000);
const frameChain = z.array(text).max(8).optional();
const semantic = { frames: frameChain, exact: z.boolean().optional(), nth: z.number().int().min(0).max(10_000).optional() };
const roles = ['alert','alertdialog','application','article','banner','blockquote','button','caption','cell','checkbox','code','columnheader','combobox','complementary','contentinfo','definition','deletion','dialog','directory','document','emphasis','feed','figure','form','generic','grid','gridcell','group','heading','img','insertion','link','list','listbox','listitem','log','main','marquee','math','meter','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','navigation','none','note','option','paragraph','presentation','progressbar','radio','radiogroup','region','row','rowgroup','rowheader','scrollbar','search','searchbox','separator','slider','spinbutton','status','strong','subscript','superscript','switch','tab','table','tablist','tabpanel','term','textbox','time','timer','toolbar','tooltip','tree','treegrid','treeitem'] as const;
export const LocatorTargetSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('role'), role: z.enum(roles), name: text.optional(), ...semantic }).strict(),
  z.object({ strategy: z.literal('label'), label: text, ...semantic }).strict(),
  z.object({ strategy: z.literal('testId'), testId: text, ...semantic }).strict(),
  z.object({ strategy: z.literal('text'), text, ...semantic }).strict(),
  z.object({ strategy: z.literal('css'), selector: text, ...semantic }).strict(),
]);
export const CoordinateTargetSchema = z.object({ strategy: z.literal('coordinates'), x: z.number().finite().min(0).max(100_000), y: z.number().finite().min(0).max(100_000) }).strict();
export const TargetSchema = z.union([LocatorTargetSchema, CoordinateTargetSchema]);
const base = { timeoutMs: z.number().int().min(50).max(120_000).optional() };
const target = { target: TargetSchema, ...base };
const locator = { target: LocatorTargetSchema, ...base };
const button = z.enum(['left', 'right', 'middle']).optional();
export const StepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: text, ...base }).strict(),
  z.object({ action: z.literal('click'), ...target, button, popup: text.optional() }).strict(),
  z.object({ action: z.literal('doubleClick'), ...target, button }).strict(),
  z.object({ action: z.literal('rightClick'), ...target }).strict(),
  z.object({ action: z.literal('move'), ...target }).strict(),
  z.object({ action: z.literal('hover'), ...target }).strict(),
  z.object({ action: z.literal('fill'), ...locator, value: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal('press'), target: LocatorTargetSchema.optional(), key: text, ...base }).strict(),
  z.object({ action: z.literal('type'), value: z.string().max(100_000), ...base }).strict(),
  z.object({ action: z.literal('down'), button, ...base }).strict(),
  z.object({ action: z.literal('up'), button, ...base }).strict(),
  z.object({ action: z.literal('wheel'), deltaX: z.number().finite().min(-100_000).max(100_000).default(0), deltaY: z.number().finite().min(-100_000).max(100_000), ...base }).strict(),
  z.object({ action: z.literal('drag'), from: TargetSchema, to: TargetSchema, steps: z.number().int().min(2).max(120).default(20), ...base }).strict(),
  z.object({ action: z.literal('wait'), ...locator, state: z.enum(['visible','hidden','attached','detached']).default('visible') }).strict(),
  z.object({ action: z.literal('expectVisible'), ...locator }).strict(),
  z.object({ action: z.literal('expectText'), ...locator, text: z.string().max(10_000), exact: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('select'), ...locator, value: text }).strict(),
  z.object({ action: z.literal('screenshot'), name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('screenshot'), ...base }).strict(),
  z.object({ action: z.literal('newPage'), name: text, path: text.optional(), ...base }).strict(),
  z.object({ action: z.literal('switchPage'), page: text, ...base }).strict(),
]);
export const TestDefinitionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
  name: z.string().min(1).max(200).default('Untitled test'),
  environment: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).default('local'),
  tags: z.array(z.string().max(60)).max(30).default([]),
  safetyLevel: z.enum(['read-only','safe-write','destructive']).default('read-only'),
  productionAllowed: z.boolean().default(false),
  testAccount: z.string().min(1).max(320).optional(),
  timeoutMs: z.number().int().min(1_000).max(1_200_000).default(120_000),
  viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).strict().optional(),
  steps: z.array(StepSchema).min(1).max(500),
}).strict();
export type BrowserTarget = z.infer<typeof TargetSchema>;
export type LocatorTarget = z.infer<typeof LocatorTargetSchema>;
export type TestStep = z.infer<typeof StepSchema>;
export type TestDefinition = z.infer<typeof TestDefinitionSchema>;
