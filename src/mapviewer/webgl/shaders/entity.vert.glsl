#version 300 es

#include "./includes/multi-draw.glsl";

// Live players, npcs and spotanims. Like npc.vert.glsl, but positioned in absolute world space:
// the CPU resolves ground height (bridges included) and writes one instance per draw.

#define TEXTURE_ANIM_UNIT (1.0f / 128.0f)

// TAU / 2048.0
#define RS_TO_RADIANS 0.00306796157

#define FOG_CORNER_ROUNDING 8.0

precision highp float;

layout(std140, column_major) uniform;

uniform highp isampler2D u_textureMaterials;

#include "./includes/scene-uniforms.glsl";

// Two texels per instance:
//   [fineX, fineY (ground height, negative is up), fineZ, yaw | plane << 11]
//   [interactId, interactType, 0, 0]
uniform highp isampler2D u_entityData;
uniform int u_entityDataOffset;

layout(location = 0) in uvec3 a_vertex;

out vec4 v_color;
out vec2 v_texCoord;
flat out uint v_texId;
flat out float v_alphaCutOff;
out float v_fogAmount;
flat out vec4 v_interactId;

#include "./includes/branchless-logic.glsl";
#include "./includes/hsl-to-rgb.glsl";
#include "./includes/unpack-float.glsl";
#include "./includes/fog.glsl";

#include "./includes/material.glsl";

#include "./includes/vertex.glsl";

ivec2 getDataTexCoord(int index) {
    return ivec2(index % 16, index / 16);
}

mat4 rotationY(in float angle) {
    return mat4(cos(angle),		0,		sin(angle),	0,
                         0,		1.0,			 0,	0,
                -sin(angle),	0,		cos(angle),	0,
                        0, 		0,				0,	1);
}

void main() {
    Vertex vertex = decodeVertex(a_vertex.x, a_vertex.y, a_vertex.z, u_brightness);

    v_color = vertex.color;

    Material material = getMaterial(vertex.textureId);
    vec2 textureAnimation = vec2(material.animU, material.animV);

    if (u_isNewTextureAnim > 0.5) {
        v_texCoord = vertex.texCoord + mod(mod(u_currentTime, 128.0) * textureAnimation / 64.0, 1.0);
    } else {
        v_texCoord = vertex.texCoord + (u_currentTime / 0.02) * textureAnimation * TEXTURE_ANIM_UNIT;
    }
    v_texId = vertex.textureId;
    v_alphaCutOff = material.alphaCutOff;

    int index = (u_entityDataOffset + DRAW_ID) * 2;
    ivec4 position = texelFetch(u_entityData, getDataTexCoord(index), 0);
    ivec4 interact = texelFetch(u_entityData, getDataTexCoord(index + 1), 0);

    float yaw = float(position.w & 0x7FF);
    float plane = float((position.w >> 11) & 0x3);

    vec4 localPos = vec4(vertex.pos, 1.0) * rotationY(yaw * RS_TO_RADIANS)
        + vec4(float(position.x), float(position.y), float(position.z), 0.0);

    localPos /= vec4(vec3(128.0), 1.0);

    float dist = -sdRoundedBox(
        vec2(localPos.x - u_cameraPos.x, localPos.z - u_cameraPos.y),
        vec2(u_renderDistance),
        FOG_CORNER_ROUNDING
    );

    float fogDepth = min(u_fogDepth, u_renderDistance);
    v_fogAmount = fogFactorLinear(dist, 0.0, fogDepth);

    v_interactId = vec4(
        float(interact.x),
        0.0,
        float(interact.y) * when_neq(v_fogAmount, 1.0),
        1.0
    );

    gl_Position = u_viewMatrix * localPos;
    gl_Position.z += plane * 0.005 + (float(vertex.priority) + 20.0) * 0.0007;
    gl_Position = u_projectionMatrix * gl_Position;
}
