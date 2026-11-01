/**
 * [dsh-p1] P1 语义召回的嵌入提供方（isolated install，v2.00）。
 *
 * transformers.js 不能装进 DSH profile 的 node_modules（那棵树依赖 DSH 私有
 * registry 的包，npm 解析不动），所以独立放在 bot-home\embed\ 下；插件里的
 * memory-embed.js 通过绝对路径 file:// 动态 import 本文件。
 *
 * 模型：Xenova/bge-small-zh-v1.5（ONNX q8，约 30MB，CPU 单条几十毫秒），
 * 首次使用时下载到 ./models/（之后离线可用）。
 *
 * 任何一步失败（没网、模型缺失、加载超时）都由调用方兜底回退二元组召回，
 * 所以这里只管抛错，不做静默降级。
 */

export { pipeline } from '@huggingface/transformers';
export { AutoProcessor, Qwen2VLForConditionalGeneration, RawImage, env } from '@huggingface/transformers';

export const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';
export const EMBED_DIM = 512;
