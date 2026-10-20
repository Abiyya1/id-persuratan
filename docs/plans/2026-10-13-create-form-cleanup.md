# Perapihan Form Buat Nomor Surat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Skill tersedia melalui `skill://executing-plans`.

**Goal:** Besok, hilangkan field Nomor Surat yang hanya menampilkan hasil otomatis, ganti label Ket menjadi Keterangan dan Hal menjadi Perihal Surat, serta hapus placeholder abu-abu Perihal surat.

**Architecture:** Perubahan presentasi minimal pada komponen bersama DocumentPortal untuk halaman Buat Nomor Surat admin dan pengguna. Alokasi nomor otomatis, payload API, validasi, konfirmasi nomor darurat dan pesan nomor yang berhasil dibuat tetap sama. Tidak mengubah tabel Cari Surat, register, backend, skema database atau Google Sheets.

**Tech Stack:** Next.js, React, TypeScript, Tailwind; tidak memerlukan dependency atau migrasi baru.

---

## Status dan batas izin

HARI INI HANYA RENCANA. Jangan mengimplementasikan, menjalankan test/build/lint, mengubah environment, melakukan commit, atau menjalankan SQL hari ini. Eksekusi hanya setelah pengguna meminta menjalankan rencana ini besok; tidak ada penjadwalan otomatis.

Sumber yang dibaca: `src/components/DocumentPortal.tsx`, snapshot 0B71. Nomor baris di bawah merupakan petunjuk, bukan anchor edit untuk besok. Baca ulang file dan kondisi repo sebelum mengedit; pertahankan perubahan pengguna yang sudah ada.

## Task 1: Hilangkan field Nomor Surat yang tidak digunakan

**Files:** Modify `src/components/DocumentPortal.tsx`, saat rencana dibuat baris 7,18,42,104,123,152.

1. Hapus seluruh blok label/input/helper untuk `create-number` (label Nomor Surat, input readonly berwarna, placeholder Otomatis setelah surat disimpan, dan teks Tidak ada nomor yang dipesan sebelum pengajuan).
2. Karena state hanya dipakai field tersebut, hapus `const [number, setNumber] = useState('')` dan semua pemanggilan `setNumber(...)` yang kini tidak dibutuhkan.
3. Hapus import `REGISTER_FILLED_NUMBER_COLOR`/`REGISTER_EMPTY_NUMBER_COLOR` dari komponen ini bila tidak lagi dipakai. Jangan hapus konstanta bersama atau warna register di komponen lain.
4. Pertahankan `const allocatedNumber = String(data.document.surat_number)` dan pesan sukses `Surat terdaftar dengan Nomor Surat ${allocatedNumber}...`. Pengguna tetap mengetahui nomor hasil pendaftaran tanpa field tambahan.
5. Rapikan tiga kontrol KD Surat, KD Satker, Keterangan menggunakan grid yang ada; tidak menambah elemen kosong atau merombak desain.

## Task 2: Ganti Ket menjadi Keterangan

**Files:** Modify `src/components/DocumentPortal.tsx`, saat ini baris 92,154.

1. Label `create-ket`: `Ket` → `Keterangan`; tanda wajib tetap.
2. Opsi kosong: `Pilih Ket` → `Pilih Keterangan`.
3. Pesan validasi dalam komponen ini yang menyebut Ket menggunakan Keterangan; contoh `Untuk tanggal selain hari ini (WIB), pilih Keterangan MANUAL.`
4. Pertahankan nama state/payload `ket`, KET_OPTIONS, nilai opsi dan pembatasan tanggal selain hari ini hanya MANUAL. Tidak mengubah kolom Sheets atau kontrak API.

## Task 3: Ganti Hal menjadi Perihal Surat, hapus placeholder

**Files:** Modify `src/components/DocumentPortal.tsx`, saat ini baris 84,156.

1. Label `create-hal`: `Hal` → `Perihal Surat`; tanda wajib tetap.
2. Hapus atribut `placeholder="Perihal surat"` sepenuhnya. Teks abu-abu itu placeholder, bukan isi surat; jangan menghapus input atau data yang diketik pengguna.
3. Sesuaikan pesan validasi `Isi Hal ...` menjadi `Isi Perihal Surat ...` dalam komponen ini.
4. Pertahankan state/payload `hal`, id input, required, maxLength 300 dan trim saat submit. Tujuan Surat tetap wajib; tidak mengubah default, tanggal, pilihan Keterangan atau logika penomoran.

## Task 4: Verifikasi dan catat hasil BESOK

1. Jalankan `npm test`, `npm run typecheck`, `npm run lint` setelah perubahan; harapkan exit code 0. Jangan menambahkan test permanen yang hanya memeriksa salinan label/source text.
2. Gunakan smoke UI komponen aktual dalam fixture terisolasi tanpa kredensial produksi. Jangan submit surat melalui aplikasi yang tersambung Supabase/Sheets asli hanya untuk pengujian.
3. Pastikan form admin/pengguna tidak lagi memiliki field Nomor Surat; label Keterangan/Perihal Surat benar; input perihal kosong tidak menampilkan placeholder; required tetap bekerja dan layout tidak overflow.
4. Dengan respons API fixture, pastikan pesan sukses masih menunjukkan nomor yang dialokasikan. Payload tetap berisi hal/ket; kegagalan, peringatan sinkronisasi dan konfirmasi nomor darurat tetap berfungsi.
5. Perbarui catatan perubahan singkat di README yang sudah ada setelah smoke lulus, dan hapus fixture sementara milik pengujian. Tidak perlu SQL, perubahan Sheets, dependency, atau commit otomatis.

## Perintah untuk besok

```text
Jalankan rencana di docs/plans/2026-10-13-create-form-cleanup.md sekarang. Terapkan hanya perubahan form Buat Nomor Surat yang tercantum, pertahankan perilaku serta kontrak data, lalu verifikasi dengan fixture terisolasi. Jangan mengubah Supabase atau Google Sheets produksi. Jangan memperluas scope ke tabel Cari Surat atau register.
```
