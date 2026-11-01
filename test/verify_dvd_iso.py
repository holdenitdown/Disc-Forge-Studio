import sys, struct, pycdlib
iso_path = sys.argv[1]
iso = pycdlib.PyCdlib(); iso.open(iso_path)
print('UDF present:', iso.has_udf())
loc = {}
for d, dirs, files in iso.walk(udf_path='/'):
    for f in files:
        rec = iso.get_record(udf_path=f"{d.rstrip('/')}/{f}")
        ext = rec.alloc_descs[0]
        loc[f] = (rec.get_data_length(), ext.log_block_num)
        print('UDF', d, f, rec.get_data_length(), 'lbn', ext.log_block_num)
iso.close()
# partition start 257: absolute = lbn + 257
ab = {k: v[1] + 257 for k, v in loc.items()}
raw = open(iso_path, 'rb')
def rd(lba, off, n):
    raw.seek(lba*2048+off); return raw.read(n)
ok = True
def chk(name, got, want):
    global ok
    s = 'OK ' if got == want else 'BAD'
    if got != want: ok = False
    print(f'{s} {name}: ifo says {got}, actual {want}')
vmg = ab['VIDEO_TS.IFO']
assert rd(vmg, 0, 12) == b'DVDVIDEO-VMG'
if 'VIDEO_TS.VOB' in ab: chk('VMG menu VOB', struct.unpack('>I', rd(vmg, 0xC0, 4))[0], ab['VIDEO_TS.VOB'] - vmg)
chk('VMG last sector (BUP end)', struct.unpack('>I', rd(vmg, 0x0C, 4))[0], ab['VIDEO_TS.BUP'] + loc['VIDEO_TS.BUP'][0]//2048 - 1 - vmg)
tt = struct.unpack('>I', rd(vmg, 0xC4, 4))[0]
n = struct.unpack('>H', rd(vmg + tt, 0, 2))[0]
for i in range(n):
    e = rd(vmg + tt, 8 + 12*i, 12)
    vtsn = e[6]; start = struct.unpack('>I', e[8:12])[0]
    chk(f'TT_SRPT title {i+1} -> VTS {vtsn} start', start, ab[f'VTS_{vtsn:02d}_0.IFO'] - vmg)
v = 1
while f'VTS_{v:02d}_0.IFO' in ab:
    b = ab[f'VTS_{v:02d}_0.IFO']
    assert rd(b, 0, 12) == b'DVDVIDEO-VTS'
    m = struct.unpack('>I', rd(b, 0xC0, 4))[0]
    if f'VTS_{v:02d}_0.VOB' in ab: chk(f'VTS{v} menu VOB', m, ab[f'VTS_{v:02d}_0.VOB'] - b)
    chk(f'VTS{v} title VOB', struct.unpack('>I', rd(b, 0xC4, 4))[0], ab[f'VTS_{v:02d}_1.VOB'] - b)
    bup = f'VTS_{v:02d}_0.BUP'
    chk(f'VTS{v} last sector', struct.unpack('>I', rd(b, 0x0C, 4))[0], ab[bup] + loc[bup][0]//2048 - 1 - b)
    v += 1
print('ALL OK' if ok else 'PROBLEMS')
