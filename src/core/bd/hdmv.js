'use strict';
/**
 * HDMV navigation command encoder (Blu-ray "movie mode" virtual machine).
 *
 * Every command is 12 bytes:
 *   byte 0: op_cnt(3) | grp(2) | sub_grp(3)
 *   byte 1: imm_op1(1) | imm_op2(1) | reserved(2) | branch_opt(4)
 *   byte 2: reserved(4) | cmp_opt(4)
 *   byte 3: reserved(3) | set_opt(5)
 *   bytes 4-7: destination operand, bytes 8-11: source operand
 *
 * Operands are immediate values when the matching imm flag is set, otherwise
 * they reference a general purpose register (GPR, 0..4095) or a player status
 * register (PSR, flagged with 0x80000000).
 */

const GRP = { BRANCH: 0, CMP: 1, SET: 2 };
const BRANCH = { GOTO: 0, JUMP: 1, PLAY: 2 };
const GOTO = { NOP: 0, GOTO: 1, BREAK: 2 };
const JUMP = { JUMP_OBJECT: 0, JUMP_TITLE: 1, CALL_OBJECT: 2, CALL_TITLE: 3, RESUME: 4 };
const PLAY = { PLAY_PL: 0, PLAY_PL_PI: 1, PLAY_PL_MK: 2, TERMINATE_PL: 3, LINK_PI: 4, LINK_MK: 5 };
const CMP = { BC: 1, EQ: 2, NE: 3, GE: 4, GT: 5, LE: 6, LT: 7 };
const SET_SUB = { SET: 0, SETSYSTEM: 1 };
const SET = { MOVE: 1, SWAP: 2, ADD: 3, SUB: 4, MUL: 5, DIV: 6, MOD: 7, RND: 8, AND: 9, OR: 10, XOR: 11, BITSET: 12, BITCLR: 13, SHL: 14, SHR: 15 };
const SETSYS = { SET_STREAM: 1, SET_NV_TIMER: 2, SET_BUTTON_PAGE: 3, ENABLE_BUTTON: 4, DISABLE_BUTTON: 5, SET_SEC_STREAM: 6, POPUP_OFF: 7, STILL_ON: 8, STILL_OFF: 9 };

/** Operand helpers: imm(n) is an immediate value, gpr(n) a general register, psr(n) a player register. */
const imm = (v) => ({ imm: true, v: v >>> 0 });
const gpr = (n) => ({ imm: false, v: n & 0xfff });
const psr = (n) => ({ imm: false, v: (0x80000000 | (n & 0x7f)) >>> 0 });

function encode({ opCnt, grp, sub, branch = 0, cmp = 0, set = 0, dst, src }) {
  const b = Buffer.alloc(12);
  const d = dst || imm(0);
  const s = src || imm(0);
  b[0] = ((opCnt & 7) << 5) | ((grp & 3) << 3) | (sub & 7);
  b[1] = ((dst && d.imm ? 1 : 0) << 7) | ((src && s.imm ? 1 : 0) << 6) | (branch & 0xf);
  b[2] = cmp & 0xf;
  b[3] = set & 0x1f;
  b.writeUInt32BE(d.v >>> 0, 4);
  b.writeUInt32BE(s.v >>> 0, 8);
  return b;
}

const asOp = (x) => (typeof x === 'number' ? imm(x) : x);

const cmd = {
  nop: () => encode({ opCnt: 0, grp: GRP.BRANCH, sub: BRANCH.GOTO, branch: GOTO.NOP }),
  /** Jump to command index n inside the current movie object. */
  goto: (n) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.GOTO, branch: GOTO.GOTO, dst: asOp(n) }),
  break: () => encode({ opCnt: 0, grp: GRP.BRANCH, sub: BRANCH.GOTO, branch: GOTO.BREAK }),
  jumpObject: (n) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.JUMP, branch: JUMP.JUMP_OBJECT, dst: asOp(n) }),
  /** Titles are 1-based as seen by the player (title 0 is the top menu). */
  jumpTitle: (n) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.JUMP, branch: JUMP.JUMP_TITLE, dst: asOp(n) }),
  callObject: (n) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.JUMP, branch: JUMP.CALL_OBJECT, dst: asOp(n) }),
  callTitle: (n) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.JUMP, branch: JUMP.CALL_TITLE, dst: asOp(n) }),
  resume: () => encode({ opCnt: 0, grp: GRP.BRANCH, sub: BRANCH.JUMP, branch: JUMP.RESUME }),
  playPL: (pl) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.PLAY, branch: PLAY.PLAY_PL, dst: asOp(pl) }),
  playPLatPI: (pl, pi) => encode({ opCnt: 2, grp: GRP.BRANCH, sub: BRANCH.PLAY, branch: PLAY.PLAY_PL_PI, dst: asOp(pl), src: asOp(pi) }),
  /** Play a playlist starting at a playlist mark (chapter marks are 0-based). */
  playPLatMK: (pl, mk) => encode({ opCnt: 2, grp: GRP.BRANCH, sub: BRANCH.PLAY, branch: PLAY.PLAY_PL_MK, dst: asOp(pl), src: asOp(mk) }),
  terminatePL: () => encode({ opCnt: 0, grp: GRP.BRANCH, sub: BRANCH.PLAY, branch: PLAY.TERMINATE_PL }),
  linkMK: (mk) => encode({ opCnt: 1, grp: GRP.BRANCH, sub: BRANCH.PLAY, branch: PLAY.LINK_MK, dst: asOp(mk) }),

  /** Conditional: when false, the following command is skipped. */
  cmp: (op, a, b) => encode({ opCnt: 2, grp: GRP.CMP, sub: 0, cmp: op, dst: asOp(a), src: asOp(b) }),
  eq: (a, b) => cmd.cmp(CMP.EQ, a, b),
  ne: (a, b) => cmd.cmp(CMP.NE, a, b),
  gt: (a, b) => cmd.cmp(CMP.GT, a, b),
  lt: (a, b) => cmd.cmp(CMP.LT, a, b),
  ge: (a, b) => cmd.cmp(CMP.GE, a, b),

  /** reg <- value (value may be an immediate number or another register). */
  move: (reg, value) => encode({ opCnt: 2, grp: GRP.SET, sub: SET_SUB.SET, set: SET.MOVE, dst: reg, src: asOp(value) }),
  add: (reg, value) => encode({ opCnt: 2, grp: GRP.SET, sub: SET_SUB.SET, set: SET.ADD, dst: reg, src: asOp(value) }),
  sub: (reg, value) => encode({ opCnt: 2, grp: GRP.SET, sub: SET_SUB.SET, set: SET.SUB, dst: reg, src: asOp(value) }),

  /**
   * Select primary audio and/or subtitle stream (1-based stream numbers as in the STN table).
   * audio: number | null; subtitle: number | 0 (off) | null (unchanged)
   */
  setStream: ({ audio = null, subtitle = null } = {}) => {
    let d = 0;
    if (audio != null) d |= 0x80000000 | ((audio & 0xfff) << 16);
    if (subtitle != null) {
      if (subtitle > 0) d |= 0x8000 | 0x4000 | (subtitle & 0xfff); // select + display on
      else d |= 0x0000; // display flag cleared => subtitles off
    }
    return encode({ opCnt: 2, grp: GRP.SET, sub: SET_SUB.SETSYSTEM, set: SETSYS.SET_STREAM, dst: imm(d >>> 0), src: imm(0) });
  },
  /** Switch IG page and/or selected button (button ids are those used in the IG stream). */
  setButtonPage: ({ page = null, button = null } = {}) => {
    let d = 0;
    let s = 0;
    if (button != null) d = (0x80000000 | (button & 0xffff)) >>> 0;
    if (page != null) s = (0x80000000 | (page & 0xff)) >>> 0;
    return encode({ opCnt: 2, grp: GRP.SET, sub: SET_SUB.SETSYSTEM, set: SETSYS.SET_BUTTON_PAGE, dst: imm(d), src: imm(s) });
  },
  popupOff: () => encode({ opCnt: 0, grp: GRP.SET, sub: SET_SUB.SETSYSTEM, set: SETSYS.POPUP_OFF }),
  stillOn: () => encode({ opCnt: 0, grp: GRP.SET, sub: SET_SUB.SETSYSTEM, set: SETSYS.STILL_ON }),
  stillOff: () => encode({ opCnt: 0, grp: GRP.SET, sub: SET_SUB.SETSYSTEM, set: SETSYS.STILL_OFF }),
};

/** Player status registers used by the authoring logic. */
const PSR = { IG_STREAM: 0, PRIMARY_AUDIO: 1, PG_STREAM: 2, TITLE: 4, CHAPTER: 5, PLAYLIST: 6, PLAYITEM: 7, SELECTED_BUTTON: 10, MENU_PAGE: 11 };

module.exports = { cmd, imm, gpr, psr, PSR, CMP };
