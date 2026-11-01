/*
 * bdplay: headless Blu-ray navigation tester built on libbluray.
 * Usage: bdplay <disc_root> <out_prefix> [keys...]
 * keys: up down left right enter menu popup wait  (each followed by ~0.5s of playback)
 * Prints navigation events and writes the IG plane to <out_prefix>_<step>.ppm after each key.
 */
#include <libbluray/bluray.h>
#include <libbluray/overlay.h>
#include <libbluray/keys.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int W = 1920, H = 1080;
static unsigned char *plane;

static void yuv2rgb(int y, int cr, int cb, unsigned char *o) {
    double Y = 1.164 * (y - 16), U = cb - 128, V = cr - 128;
    int r = (int)(Y + 1.793 * V), g = (int)(Y - 0.213 * U - 0.533 * V), b = (int)(Y + 2.112 * U);
    o[0] = r < 0 ? 0 : r > 255 ? 255 : r; o[1] = g < 0 ? 0 : g > 255 ? 255 : g; o[2] = b < 0 ? 0 : b > 255 ? 255 : b;
}

static void overlay_cb(void *h, const BD_OVERLAY *const ov) {
    (void)h;
    if (!ov) return;
    if (ov->plane != BD_OVERLAY_IG) return;
    switch (ov->cmd) {
    case BD_OVERLAY_INIT:
        W = ov->w; H = ov->h; free(plane); plane = calloc((size_t)W * H, 4);
        printf("OVERLAY INIT %dx%d\n", W, H);
        break;
    case BD_OVERLAY_CLEAR: case BD_OVERLAY_HIDE:
        if (plane) memset(plane, 0, (size_t)W * H * 4);
        break;
    case BD_OVERLAY_WIPE:
        for (int y = ov->y; y < ov->y + ov->h && y < H; y++) memset(plane + ((size_t)y * W + ov->x) * 4, 0, (size_t)ov->w * 4);
        break;
    case BD_OVERLAY_DRAW: {
        const BD_PG_RLE_ELEM *r = ov->img;
        printf("OVERLAY DRAW x=%d y=%d w=%d h=%d\n", ov->x, ov->y, ov->w, ov->h);
        for (int y = 0; y < ov->h; y++) {
            int x = 0;
            while (x < ov->w || (r->len == 0 && x == ov->w)) {
                if (r->len == 0) { r++; break; }
                for (int i = 0; i < r->len && x < ov->w; i++, x++) {
                    const BD_PG_PALETTE_ENTRY *p = &ov->palette[r->color];
                    int px = ov->x + x, py = ov->y + y;
                    if (px < W && py < H && p->T) {
                        unsigned char *o = plane + ((size_t)py * W + px) * 4;
                        yuv2rgb(p->Y, p->Cr, p->Cb, o); o[3] = p->T;
                    }
                }
                r++;
            }
        }
        break;
    }
    default: break;
    }
}

static void dump(const char *prefix, int step) {
    if (!plane) return;
    char fn[512]; snprintf(fn, sizeof fn, "%s_%02d.ppm", prefix, step);
    FILE *f = fopen(fn, "wb"); if (!f) return;
    fprintf(f, "P6\n%d %d\n255\n", W, H);
    for (int i = 0; i < W * H; i++) {
        unsigned char *p = plane + (size_t)i * 4; int a = p[3];
        unsigned char bg = 40;
        unsigned char px[3] = { (unsigned char)((p[0] * a + bg * (255 - a)) / 255), (unsigned char)((p[1] * a + bg * (255 - a)) / 255), (unsigned char)((p[2] * a + bg * (255 - a)) / 255) };
        fwrite(px, 1, 3, f);
    }
    fclose(f);
}

static const char *ev_name(uint32_t e) {
    switch (e) {
    case BD_EVENT_TITLE: return "TITLE"; case BD_EVENT_PLAYLIST: return "PLAYLIST"; case BD_EVENT_PLAYITEM: return "PLAYITEM";
    case BD_EVENT_CHAPTER: return "CHAPTER"; case BD_EVENT_MENU: return "MENU"; case BD_EVENT_AUDIO_STREAM: return "AUDIO_STREAM";
    case BD_EVENT_PG_TEXTST_STREAM: return "PG_STREAM"; case BD_EVENT_PG_TEXTST: return "PG_DISPLAY"; case BD_EVENT_IG_STREAM: return "IG_STREAM";
    case BD_EVENT_STILL: return "STILL"; case BD_EVENT_STILL_TIME: return "STILL_TIME"; case BD_EVENT_END_OF_TITLE: return "END_OF_TITLE";
    case BD_EVENT_ERROR: return "ERROR"; case BD_EVENT_READ_ERROR: return "READ_ERROR"; case BD_EVENT_POPUP: return "POPUP";
    case BD_EVENT_UO_MASK_CHANGED: return "UO_MASK"; case BD_EVENT_STEREOSCOPIC_STATUS: return "STEREO"; case BD_EVENT_SEEK: return "SEEK";
    case BD_EVENT_DISCONTINUITY: return "DISCONT"; case BD_EVENT_IDLE: return "IDLE"; case BD_EVENT_PLAYMARK: return "PLAYMARK";
    case BD_EVENT_ANGLE: return "ANGLE"; case BD_EVENT_KEY_INTEREST_TABLE: return "KEY_INTEREST"; case BD_EVENT_PLAYLIST_STOP: return "PLAYLIST_STOP";
    default: return NULL;
    }
}

static void run(BLURAY *bd, double seconds) {
    static unsigned char buf[6144 * 32];
    BD_EVENT ev;
    uint64_t start = bd_tell_time(bd);
    int idle = 0;
    for (int i = 0; i < 4000; i++) {
        int n = bd_read_ext(bd, buf, sizeof buf, &ev);
        do {
            const char *nm = ev_name(ev.event);
            if (ev.event != BD_EVENT_NONE && nm && ev.event != BD_EVENT_IDLE && ev.event != BD_EVENT_UO_MASK_CHANGED && ev.event != BD_EVENT_KEY_INTEREST_TABLE)
                printf("EVENT %s %u\n", nm, ev.param);
            if (ev.event == BD_EVENT_STILL_TIME || ev.event == BD_EVENT_STILL) { if (ev.event == BD_EVENT_STILL_TIME && ev.param == 0) idle++; }
            if (ev.event == BD_EVENT_IDLE) idle++;
        } while (bd_get_event(bd, &ev) && ev.event != BD_EVENT_NONE);
        if (n < 0) { printf("READ ERROR\n"); break; }
        uint64_t now = bd_tell_time(bd);
        if (now > start && (now - start) > (uint64_t)(seconds * 90000)) break;
        if (idle > 50) break;
    }
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s disc out_prefix [keys]\n", argv[0]); return 2; }
    BLURAY *bd = bd_open(argv[1], NULL);
    if (!bd) { printf("OPEN FAILED\n"); return 1; }
    const BLURAY_DISC_INFO *di = bd_get_disc_info(bd);
    printf("DISC bluray=%d first_play=%d top_menu=%d hdmv_titles=%d titles=%u\n", di->bluray_detected, di->first_play_supported,
           di->top_menu_supported, di->num_hdmv_titles, di->num_titles);
    bd_register_overlay_proc(bd, NULL, overlay_cb);
    if (!bd_play(bd)) { printf("PLAY FAILED\n"); return 1; }
    run(bd, 3.0);
    dump(argv[2], 0);
    for (int k = 3; k < argc; k++) {
        uint32_t key = 0;
        const char *s = argv[k];
        if (!strcmp(s, "up")) key = BD_VK_UP; else if (!strcmp(s, "down")) key = BD_VK_DOWN;
        else if (!strcmp(s, "left")) key = BD_VK_LEFT; else if (!strcmp(s, "right")) key = BD_VK_RIGHT;
        else if (!strcmp(s, "enter")) key = BD_VK_ENTER; else if (!strcmp(s, "menu")) key = BD_VK_ROOT_MENU;
        else if (!strcmp(s, "popup")) key = BD_VK_POPUP;
        printf("KEY %s\n", s);
        if (key) bd_user_input(bd, -1, key);
        run(bd, 2.0);
        printf("STATE title=%u playlist? chapter=%u time=%.2f\n", bd_get_current_title(bd), bd_get_current_chapter(bd), bd_tell_time(bd) / 90000.0);
        dump(argv[2], k - 2);
    }
    bd_close(bd);
    return 0;
}
