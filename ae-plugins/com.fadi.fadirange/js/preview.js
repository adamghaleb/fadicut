/* fadiRange — WebGL preview engine
 * Renders the range key (luma/color + threshold/feather) and the chosen preset
 * live on a grabbed frame, driven by the modulation clock. Tuned to visually
 * match what the native AE bake (Extract / Linear Color Key / Colorama / etc.)
 * will produce. */

(function (global) {
	"use strict";

	var VERT = [
		"attribute vec2 aPos;",
		"varying vec2 vUv;",
		"void main(){",
		"  vUv = vec2((aPos.x+1.0)*0.5, 1.0-(aPos.y+1.0)*0.5);",
		"  gl_Position = vec4(aPos,0.0,1.0);",
		"}",
	].join("\n");

	var FRAG = [
		"precision highp float;",
		"varying vec2 vUv;",
		"uniform sampler2D uImage;",
		"uniform vec2 uRes;",
		"uniform int uMode;", // 0 whole, 1 luma, 2 color
		"uniform float uLo;", // luma low / color tolerance handled below
		"uniform float uHi;", // luma high
		"uniform float uFeather;",
		"uniform vec3 uTarget;", // color-range target
		"uniform float uTol;", // color-range tolerance
		"uniform int uPreset;", // 0 opacity,1 recolor,2 cycle,3 mosaic,4 posterize,5 glow
		"uniform float uAmount;", // modulation 0..1
		"uniform float uPhase;", // cycle phase 0..1
		"uniform float uMosaic;", // block size px
		"uniform float uPoster;", // posterize levels
		"uniform float uThreshold;", // threshold split 0..1
		"uniform vec3 uDuoColor;", // duotone fadi color
		"uniform vec3 uFadi[7];",
		"uniform vec3 uBg;", // background shown when opacity preset hides

		"float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }",

		// RGB <-> HSL so recolor can substitute H+S while preserving L (Fadi grade)
		"vec3 rgb2hsl(vec3 c){",
		"  float mx=max(max(c.r,c.g),c.b); float mn=min(min(c.r,c.g),c.b);",
		"  float l=(mx+mn)*0.5; float h=0.0; float s=0.0; float d=mx-mn;",
		"  if(d>0.00001){",
		"    s = l>0.5 ? d/(2.0-mx-mn) : d/(mx+mn);",
		"    if(mx==c.r) h=(c.g-c.b)/d + (c.g<c.b?6.0:0.0);",
		"    else if(mx==c.g) h=(c.b-c.r)/d + 2.0;",
		"    else h=(c.r-c.g)/d + 4.0;",
		"    h/=6.0;",
		"  }",
		"  return vec3(h,s,l);",
		"}",
		"float hue2rgb(float p,float q,float t){",
		"  if(t<0.0)t+=1.0; if(t>1.0)t-=1.0;",
		"  if(t<1.0/6.0)return p+(q-p)*6.0*t;",
		"  if(t<1.0/2.0)return q;",
		"  if(t<2.0/3.0)return p+(q-p)*(2.0/3.0-t)*6.0;",
		"  return p;",
		"}",
		"vec3 hsl2rgb(vec3 hsl){",
		"  float h=hsl.x,s=hsl.y,l=hsl.z;",
		"  if(s<0.00001) return vec3(l);",
		"  float q = l<0.5 ? l*(1.0+s) : l+s-l*s; float p=2.0*l-q;",
		"  return vec3(hue2rgb(p,q,h+1.0/3.0),hue2rgb(p,q,h),hue2rgb(p,q,h-1.0/3.0));",
		"}",

		// substitute hue+sat of a fadi color, keep original L
		"vec3 fadiSub(vec3 src, vec3 fadi){",
		"  vec3 a=rgb2hsl(src); vec3 b=rgb2hsl(fadi);",
		"  return hsl2rgb(vec3(b.x, b.y, a.z));",
		"}",

		"vec3 pickFadi(float t){", // t 0..1 -> interpolated ramp color
		"  float f=clamp(t,0.0,1.0)*6.0; int i=int(floor(f)); float frac=f-float(i);",
		"  vec3 a=uFadi[0]; vec3 b=uFadi[0];",
		"  for(int k=0;k<7;k++){ if(k==i)a=uFadi[k]; if(k==i+1)b=uFadi[k]; }",
		"  return mix(a,b,frac);",
		"}",

		"void main(){",
		"  vec2 uv = vUv;",
		"  vec3 src = texture2D(uImage, uv).rgb;",
		"  float L = luma(src);",

		// ---- range mask ----
		"  float mask = 1.0;",
		"  if(uMode==1){", // luma band
		"    float f = max(uFeather,0.001);",
		"    float lo = smoothstep(uLo-f, uLo+f, L);",
		"    float hi = 1.0 - smoothstep(uHi-f, uHi+f, L);",
		"    mask = clamp(lo*hi,0.0,1.0);",
		"  } else if(uMode==2){", // color range
		"    float d = distance(src, uTarget);",
		"    float f = max(uFeather,0.001);",
		"    mask = 1.0 - smoothstep(uTol-f, uTol+f, d);",
		"  }",

		// ---- preset effect ----
		"  vec3 eff = src;",
		"  if(uPreset==0){", // opacity -> hide toward bg
		"    eff = uBg;",
		"  } else if(uPreset==1){", // fadi recolor (luma -> ramp, keep L)
		"    eff = fadiSub(src, pickFadi(L));",
		"  } else if(uPreset==2){", // fadi cycle (one color, phase-driven)
		"    eff = fadiSub(src, pickFadi(uPhase));",
		"  } else if(uPreset==3){", // mosaic
		"    float bs = max(uMosaic,1.0);",
		"    vec2 px = uRes/bs;",
		"    vec2 snap = (floor(uv*px)+0.5)/px;",
		"    eff = texture2D(uImage, snap).rgb;",
		"  } else if(uPreset==4){", // posterize
		"    float lv = max(uPoster,2.0);",
		"    eff = floor(src*lv+0.5)/lv;",
		"  } else if(uPreset==5){", // glow (cheap approx)
		"    float hot = smoothstep(0.55,1.0,L);",
		"    eff = clamp(src + src*hot*1.4, 0.0, 1.0);",
		"  } else {", // threshold family (6,7,8)
		"    float aa = 0.015;",
		"    float t = smoothstep(uThreshold-aa, uThreshold+aa, L);", // 0 dark .. 1 light
		"    if(uPreset==6){ eff = vec3(t); }", // pure B&W
		"    else if(uPreset==7){ eff = mix(vec3(0.0), uDuoColor, t); }", // lights fadi / darks black
		"    else { eff = mix(uDuoColor, vec3(1.0), t); }", // lights white / darks fadi
		"  }",

		"  vec3 outc = mix(src, eff, mask*uAmount);",
		"  gl_FragColor = vec4(outc,1.0);",
		"}",
	].join("\n");

	function compile(gl, type, src) {
		var sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			throw new Error("shader: " + gl.getShaderInfoLog(sh));
		}
		return sh;
	}

	function FadiPreview(canvas) {
		var gl =
			canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
		if (!gl) throw new Error("WebGL unavailable");
		this.gl = gl;
		this.canvas = canvas;
		this.hasImage = false;

		var prog = gl.createProgram();
		gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
		gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			throw new Error("link: " + gl.getProgramInfoLog(prog));
		}
		gl.useProgram(prog);
		this.prog = prog;

		var buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
			gl.STATIC_DRAW,
		);
		var aPos = gl.getAttribLocation(prog, "aPos");
		gl.enableVertexAttribArray(aPos);
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

		this.tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		this.u = {};
		var names = [
			"uImage",
			"uRes",
			"uMode",
			"uLo",
			"uHi",
			"uFeather",
			"uTarget",
			"uTol",
			"uPreset",
			"uAmount",
			"uPhase",
			"uMosaic",
			"uPoster",
			"uThreshold",
			"uDuoColor",
			"uBg",
		];
		for (var i = 0; i < names.length; i++) {
			this.u[names[i]] = gl.getUniformLocation(prog, names[i]);
		}
		this.uFadi = gl.getUniformLocation(prog, "uFadi[0]");

		// defaults
		this.params = {
			mode: 0,
			lo: 0.2,
			hi: 0.8,
			feather: 0.08,
			target: [1, 0, 0.37],
			tol: 0.4,
			preset: 0,
			amount: 1,
			phase: 0,
			mosaic: 16,
			poster: 6,
			threshold: 0.5,
			duoColor: [1, 0, 0.376],
			fadi: [
				[1, 0, 0.376],
				[1, 0.643, 0.02],
				[1, 0.894, 0],
				[0.067, 1, 0.02],
				[0.02, 0.827, 1],
				[0.435, 0.02, 1],
				[0.965, 0.02, 1],
			],
			bg: [0.067, 0.067, 0.067],
		};
	}

	FadiPreview.prototype.setImage = function (img) {
		var gl = this.gl;
		// size canvas to image aspect (cap width 240 internal)
		var w = img.naturalWidth || img.width;
		var h = img.naturalHeight || img.height;
		if (!w || !h) return;
		var maxW = 480;
		var scale = w > maxW ? maxW / w : 1;
		this.canvas.width = Math.round(w * scale);
		this.canvas.height = Math.round(h * scale);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
		this.imgW = w;
		this.imgH = h;
		this.hasImage = true;
		this.render();
	};

	FadiPreview.prototype.set = function (patch) {
		for (var k in patch) if (patch.hasOwnProperty(k)) this.params[k] = patch[k];
		this.render();
	};

	FadiPreview.prototype.pickColorAt = function (nx, ny) {
		// nx,ny normalized 0..1 in canvas space -> read source pixel via a temp draw
		// Cheaper: read from the rendered framebuffer is post-effect, so instead
		// re-read the source texture by sampling the original image through a 1px draw.
		// Simplest robust path: use the canvas pixel (pre-effect we force amount via flag).
		var gl = this.gl;
		// temporarily render source only (amount 0) to read true source color
		var savedAmount = this.params.amount;
		this.params.amount = 0;
		this.render();
		var px = Math.floor(nx * this.canvas.width);
		var py = Math.floor((1 - ny) * this.canvas.height); // gl y-flip
		var data = new Uint8Array(4);
		gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
		this.params.amount = savedAmount;
		this.render();
		return [data[0] / 255, data[1] / 255, data[2] / 255];
	};

	FadiPreview.prototype.render = function () {
		var gl = this.gl,
			u = this.u,
			p = this.params;
		if (!this.hasImage) {
			gl.clearColor(0.067, 0.067, 0.067, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			return;
		}
		gl.useProgram(this.prog);
		gl.uniform1i(u.uImage, 0);
		gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
		gl.uniform1i(u.uMode, p.mode);
		gl.uniform1f(u.uLo, p.lo);
		gl.uniform1f(u.uHi, p.hi);
		gl.uniform1f(u.uFeather, p.feather);
		gl.uniform3fv(u.uTarget, p.target);
		gl.uniform1f(u.uTol, p.tol);
		gl.uniform1i(u.uPreset, p.preset);
		gl.uniform1f(u.uAmount, p.amount);
		gl.uniform1f(u.uPhase, p.phase);
		gl.uniform1f(u.uMosaic, p.mosaic);
		gl.uniform1f(u.uPoster, p.poster);
		gl.uniform1f(u.uThreshold, p.threshold);
		gl.uniform3fv(u.uDuoColor, p.duoColor);
		gl.uniform3fv(u.uBg, p.bg);
		var flat = [];
		for (var i = 0; i < 7; i++) {
			flat.push(p.fadi[i][0], p.fadi[i][1], p.fadi[i][2]);
		}
		gl.uniform3fv(this.uFadi, new Float32Array(flat));
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	};

	global.FadiPreview = FadiPreview;
})(window);
