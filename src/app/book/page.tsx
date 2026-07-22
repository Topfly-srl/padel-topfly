import { BookingCheckout } from "@/components/booking-checkout";
import { createBookingInitialState } from "@/lib/booking-initial-state";
import { appConfig } from "@/lib/config";

type BookPageProps = {
  searchParams: Promise<{
    date?: string;
    time?: string;
    duration?: string;
  }>;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

function safeDuration(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 15 && parsed <= 120 ? parsed : 60;
}

export default async function BookPage({ searchParams }: BookPageProps) {
  const query = await searchParams;
  const fallback = createBookingInitialState(new Date(), appConfig.timeZone);
  const selectedDate = query.date && datePattern.test(query.date) ? query.date : fallback.date;
  const selectedTime = query.time && timePattern.test(query.time) ? query.time : fallback.time;

  return (
    <BookingCheckout
      allowedDomain={appConfig.allowedDomain}
      duration={safeDuration(query.duration)}
      selectedDate={selectedDate}
      selectedTime={selectedTime}
      timeZone={appConfig.timeZone}
    />
  );
}
