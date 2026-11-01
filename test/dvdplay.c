/* dvdplay: headless DVD menu navigation tester using libdvdnav.
 * usage: dvdplay <VIDEO_TS parent> keys...   keys: up down left right enter menu
 * Each key is applied the next time the VM is in a menu with buttons. */
#include <dvdnav/dvdnav.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    dvdnav_t *nav;
    if (dvdnav_open(&nav, argv[1]) != DVDNAV_STATUS_OK) { printf("OPEN FAILED\n"); return 1; }
    dvdnav_set_readahead_flag(nav, 1);
    uint8_t buf[2048];
    int k = 2, blocks = 0, last_title = -1, last_part = -1, menu_blocks = 0, still_count = 0;
    for (int i = 0; i < 200000; i++) {
        int ev, len;
        uint8_t *b = buf;
        if (dvdnav_get_next_block(nav, b, &ev, &len) != DVDNAV_STATUS_OK) { printf("ERROR %s\n", dvdnav_err_to_string(nav)); break; }
        int32_t title = 0, part = 0;
        switch (ev) {
        case DVDNAV_BLOCK_OK: blocks++; break;
        case DVDNAV_STILL_FRAME: {
            dvdnav_still_event_t *s = (dvdnav_still_event_t *)b;
            if (++still_count > 3 || s->length < 0xff) dvdnav_still_skip(nav);
            break; }
        case DVDNAV_WAIT: dvdnav_wait_skip(nav); break;
        case DVDNAV_VTS_CHANGE: break;
        case DVDNAV_CELL_CHANGE:
            dvdnav_current_title_info(nav, &title, &part);
            if (title != last_title || part != last_part) {
                printf("POSITION title=%d part=%d%s\n", title, part, title == 0 ? " (menu)" : "");
                last_title = title; last_part = part;
            }
            break;
        case DVDNAV_NAV_PACKET: {
            pci_t *pci = dvdnav_get_current_nav_pci(nav);
            dvdnav_current_title_info(nav, &title, &part);
            if (pci && pci->hli.hl_gi.btn_ns > 0) {
                if (++menu_blocks < 3) break;
                menu_blocks = 0;
                int32_t btn = 0; dvdnav_get_current_highlight(nav, &btn);
                if (k >= argc) { printf("DONE in menu, %d buttons, highlight=%d\n", pci->hli.hl_gi.btn_ns, btn); dvdnav_close(nav); return 0; }
                const char *key = argv[k++];
                printf("MENU buttons=%d highlight=%d KEY %s\n", pci->hli.hl_gi.btn_ns, btn, key);
                still_count = 0;
                if (!strcmp(key, "up")) dvdnav_upper_button_select(nav, pci);
                else if (!strcmp(key, "down")) dvdnav_lower_button_select(nav, pci);
                else if (!strcmp(key, "left")) dvdnav_left_button_select(nav, pci);
                else if (!strcmp(key, "right")) dvdnav_right_button_select(nav, pci);
                else if (!strcmp(key, "enter")) dvdnav_button_activate(nav, pci);
            } else if (title > 0 && blocks > 2000 && k < argc && !strcmp(argv[k], "menu")) {
                printf("KEY menu (during title %d)\n", title); k++;
                dvdnav_menu_call(nav, DVD_MENU_Root);
                blocks = 0;
            }
            break; }
        case DVDNAV_AUDIO_STREAM_CHANGE: {
            dvdnav_audio_stream_change_event_t *a = (dvdnav_audio_stream_change_event_t *)b;
            printf("AUDIO stream=%d\n", a->logical); break; }
        case DVDNAV_SPU_STREAM_CHANGE: {
            dvdnav_spu_stream_change_event_t *s = (dvdnav_spu_stream_change_event_t *)b;
            printf("SUBTITLE wide=%d logical=%d\n", s->physical_wide, s->logical); break; }
        case DVDNAV_STOP: printf("STOP\n"); dvdnav_close(nav); return 0;
        default: break;
        }
    }
    printf("END (loop limit)\n");
    dvdnav_close(nav);
    return 0;
}
