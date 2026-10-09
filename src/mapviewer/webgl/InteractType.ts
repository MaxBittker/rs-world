export enum InteractType {
    NONE = 0,
    LOC = 1, // object
    OBJ = 2, // item
    NPC = 3,
    // Live world feed entities; the interact id is the player slot / npc nid.
    LIVE_PLAYER = 4,
    LIVE_NPC = 5,
}
