/**
 * WebGL fragment-shader preview of the Fadi grade.
 *
 * This is the *approximate browser preview* half of the "preview vs authoritative"
 * convention. The exact pixels are baked natively by bridge/render/fadi_grade.py; this
 * shader reproduces the same HLS hue+sat substitution (Photoshop "Color" blend, L
 * preserved) on the GPU from the SAME GradeEffectParams so the editor looks right.
 *
 * Usage:
 *   const preview = createGradePreview(canvas);
 *   preview.setSource(imageOrVideoElement);
 *   preview.render(gradeParams);
 *   // …on unmount:
 *   preview.dispose();
 */

import { FADI_PALETTE, type GradeEffectParams, type GradeMode } from "./types";

const MODE_ID: Record<GradeMode, number> = {
	hls_substitution: 0,
	rainbow: 1,
	hue_shift: 2,
	outline: 3,
};

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// FADI_SAT = 1.35 matches fadi_grade.py.
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform int   u_mode;        // 0 hls_sub, 1 rainbow, 2 hue_shift, 3 outline
uniform vec3  u_fadi;        // substitution color (rgb 0..1) for single-color modes
uniform float u_satThresh;
uniform float u_valThresh;
uniform float u_hueDeg;
uniform vec2  u_texel;       // 1/width, 1/height for edge sampling

const float FADI_SAT = 1.35;

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Photoshop "Color" blend: keep source L, take H+S from the target color.
vec3 colorBlend(vec3 src, vec3 target){
  vec3 sh = rgb2hsv(src);
  float L = (max(max(src.r,src.g),src.b) + min(min(src.r,src.g),src.b)) * 0.5;
  vec3 th = rgb2hsv(target);
  float sat = clamp((1.0 - abs(2.0*L - 1.0)) * th.y * FADI_SAT, 0.0, 1.0);
  // rebuild around L with target hue + scaled chroma
  float c = sat;
  float x = c * (1.0 - abs(mod(th.x * 6.0, 2.0) - 1.0));
  float m = L - c * 0.5;
  vec3 rgb;
  int seg = int(mod(floor(th.x * 6.0), 6.0));
  if (seg == 0) rgb = vec3(c, x, 0.0);
  else if (seg == 1) rgb = vec3(x, c, 0.0);
  else if (seg == 2) rgb = vec3(0.0, c, x);
  else if (seg == 3) rgb = vec3(0.0, x, c);
  else if (seg == 4) rgb = vec3(x, 0.0, c);
  else rgb = vec3(c, 0.0, x);
  return clamp(rgb + m, 0.0, 1.0);
}

float subjectMask(vec2 uv){
  vec3 c = texture(u_tex, uv).rgb;
  vec3 hsv = rgb2hsv(c);
  return (hsv.y >= u_satThresh && hsv.z >= u_valThresh) ? 1.0 : 0.0;
}

void main(){
  vec3 src = texture(u_tex, v_uv).rgb;

  if (u_mode == 2) {           // hue_shift
    vec3 hsv = rgb2hsv(src);
    hsv.x = fract(hsv.x + u_hueDeg / 360.0);
    fragColor = vec4(hsv2rgb(hsv), 1.0);
    return;
  }
  if (u_mode == 1) {           // rainbow (full-frame substitution)
    fragColor = vec4(colorBlend(src, u_fadi), 1.0);
    return;
  }

  float m = subjectMask(v_uv);
  vec3 col = colorBlend(src, u_fadi);

  if (u_mode == 3) {           // outline: white fill + fadi stroke
    vec3 filled = (m > 0.5) ? vec3(1.0) : src;
    float dil = m;
    dil = max(dil, subjectMask(v_uv + vec2(u_texel.x, 0.0)));
    dil = max(dil, subjectMask(v_uv - vec2(u_texel.x, 0.0)));
    dil = max(dil, subjectMask(v_uv + vec2(0.0, u_texel.y)));
    dil = max(dil, subjectMask(v_uv - vec2(0.0, u_texel.y)));
    float stroke = clamp(dil - m, 0.0, 1.0);
    fragColor = vec4(mix(filled, col, stroke), 1.0);
    return;
  }

  // hls_substitution
  fragColor = vec4(mix(src, col, m), 1.0);
}`;

function hexToRgb01(hex?: string | null): [number, number, number] {
	const s = (hex ?? FADI_PALETTE[4]).replace(/^#/, "");
	const r = parseInt(s.slice(0, 2), 16) / 255;
	const g = parseInt(s.slice(2, 4), 16) / 255;
	const b = parseInt(s.slice(4, 6), 16) / 255;
	return [
		Number.isNaN(r) ? 0 : r,
		Number.isNaN(g) ? 0 : g,
		Number.isNaN(b) ? 0 : b,
	];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
	const sh = gl.createShader(type)!;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error(`shader compile failed: ${log}`);
	}
	return sh;
}

export interface GradePreview {
	setSource(src: TexImageSource): void;
	render(params: GradeEffectParams, frameIndex?: number): void;
	dispose(): void;
}

/** Build a WebGL2 grade preview bound to a canvas. Throws if WebGL2 is unavailable. */
export function createGradePreview(canvas: HTMLCanvasElement): GradePreview {
	const gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
	if (!gl) throw new Error("WebGL2 not available");

	const prog = gl.createProgram()!;
	gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
	gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
	}
	gl.useProgram(prog);

	const buf = gl.createBuffer()!;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	// fullscreen triangle
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array([-1, -1, 3, -1, -1, 3]),
		gl.STATIC_DRAW,
	);
	const loc = gl.getAttribLocation(prog, "a_pos");
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	const tex = gl.createTexture()!;
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

	const u = {
		mode: gl.getUniformLocation(prog, "u_mode"),
		fadi: gl.getUniformLocation(prog, "u_fadi"),
		sat: gl.getUniformLocation(prog, "u_satThresh"),
		val: gl.getUniformLocation(prog, "u_valThresh"),
		hue: gl.getUniformLocation(prog, "u_hueDeg"),
		texel: gl.getUniformLocation(prog, "u_texel"),
	};

	let texW = 1;
	let texH = 1;

	return {
		setSource(src: TexImageSource) {
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
			// best-effort dimensions for the edge-sampling texel size
			const anySrc = src as {
				width?: number;
				videoWidth?: number;
				height?: number;
				videoHeight?: number;
			};
			texW = anySrc.width || anySrc.videoWidth || canvas.width || 1;
			texH = anySrc.height || anySrc.videoHeight || canvas.height || 1;
		},
		render(params: GradeEffectParams, frameIndex = 0) {
			gl.useProgram(prog);
			gl.viewport(0, 0, canvas.width, canvas.height);

			// rainbow cycles the palette per everyNFrames
			let color = params.fadiColor ?? FADI_PALETTE[4];
			if (params.mode === "rainbow") {
				const every = Math.max(1, params.params.everyNFrames ?? 3);
				color =
					FADI_PALETTE[Math.floor(frameIndex / every) % FADI_PALETTE.length];
			}
			const [r, g, b] = hexToRgb01(color);

			gl.uniform1i(u.mode, MODE_ID[params.mode]);
			gl.uniform3f(u.fadi, r, g, b);
			gl.uniform1f(u.sat, params.params.satThreshold ?? 0.18);
			gl.uniform1f(u.val, params.params.valThreshold ?? 0.22);
			gl.uniform1f(u.hue, params.params.hueDeg ?? 60);
			gl.uniform2f(u.texel, 1 / texW, 1 / texH);

			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		},
		dispose() {
			gl.deleteTexture(tex);
			gl.deleteBuffer(buf);
			gl.deleteProgram(prog);
		},
	};
}
