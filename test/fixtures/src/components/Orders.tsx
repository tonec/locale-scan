import { t } from '../i18n';

export function Orders({ code }: { code: string }) {
  return (
    <div title={t("orders.issue_date")}>
      {t('orders.submit')}
      {t(`error.${code}.message`)}
      {t('level.' + code)}
    </div>
  );
}
