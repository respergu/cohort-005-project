{% if data.outcome == "seats_cancelled" %}
A refund for **{{ data.buyer_name | escape }}**’s Team Licence on **{{ data.course_title | escape }}** was approved, so {{ data.seats_cancelled | escape }} Unclaimed {% if data.seats_cancelled == 1 %}Seat was{% else %}Seats were{% endif %} cancelled.
{% elsif data.outcome == "enrollment_kept" %}
A refund for **{{ data.buyer_name | escape }}** on **{{ data.course_title | escape }}** was approved. They keep their Enrollment through a Claimed Seat.
{% else %}
**{{ data.buyer_name | escape }}** lost their Enrollment on **{{ data.course_title | escape }}** after a refund was approved.
{% endif %}
