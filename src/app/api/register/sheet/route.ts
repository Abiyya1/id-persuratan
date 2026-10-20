import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { readSheetRegisterMonth, describeSheetsError, sheetsUserMessage } from '@/lib/google-sheets';

export async function GET(req: Request) {
  const response = await handleRoute(async () => {
    await requireUser();
    const months = new URL(req.url).searchParams.getAll('month');
    if (months.length !== 1 || !/^(?:[1-9]|1[0-2])$/.test(months[0])) {
      return jsonError('Bulan harus berupa bilangan bulat 1 sampai 12.', 400);
    }

    try {
      return Response.json(await readSheetRegisterMonth(Number(months[0])));
    } catch (err) {
      console.error('[register/sheet] read failed:', describeSheetsError(err));
      return jsonError(`Register Google Sheets belum dapat dibaca. ${sheetsUserMessage(err)}`, 503);
    }
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
