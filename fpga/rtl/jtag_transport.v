module jtag_transport(
    input wire clk, input wire reset_n,
    output reg restart,
    output wire [7:0] rx_data, output wire rx_valid,
    input wire [7:0] tx_data, input wire tx_valid, output wire tx_ready,
    input wire stream_error
);
    wire tck, tdi, capture_dr, shift_dr, update_dr;
    wire instruction;
    reg [127:0] shift = 0;
    reg [63:0] request = 0;
    reg request_toggle = 0;
    reg ack = 0, ack_meta = 0, ack_sync = 0;
    reg req_meta = 0, req_sync = 0;
    reg [111:0] response = 0;
    reg [3:0] response_bytes = 0;
    reg result_meta = 0, result_sync = 0;
    reg error_meta = 0, error_sync = 0;
    wire result_ready = response_bytes == 14;
    reg [55:0] packet;
    reg [2:0] bytes_left;

    sld_virtual_jtag #(.sld_instance_index(0), .sld_ir_width(1)) endpoint(
        .tck(tck), .tdi(tdi), .tdo(shift[0]), .ir_in(instruction), .ir_out(1'b0),
        .virtual_state_cdr(capture_dr), .virtual_state_sdr(shift_dr),
        .virtual_state_udr(update_dr)
    );

    // Each mailbox stays stable until its synchronized acknowledgment.
    always @(posedge tck) begin
        ack_meta <= ack;
        ack_sync <= ack_meta;
        result_meta <= result_ready;
        result_sync <= result_meta;
        error_meta <= stream_error;
        error_sync <= error_meta;
        if (instruction) begin
            if (capture_dr)
                shift <= {8'hA7, 5'b0, error_sync, result_sync,
                          ack_sync == request_toggle, result_sync ? response : 112'b0};
            else if (shift_dr)
                shift <= {tdi, shift[127:1]};
            if (update_dr && shift[63:56] != 0 && ack_sync == request_toggle) begin
                request <= shift[63:0];
                request_toggle <= !request_toggle;
            end
        end
    end

    assign rx_data = packet[7:0];
    assign rx_valid = bytes_left != 0;
    assign tx_ready = !result_ready && !restart && reset_n;

    always @(posedge clk) begin
        req_meta <= request_toggle;
        req_sync <= req_meta;
        restart <= 0;
        if (!reset_n) begin
            bytes_left <= 0;
            packet <= 0;
            response <= 0;
            response_bytes <= 0;
            ack <= req_sync;
        end else begin
            if (rx_valid) begin
                packet <= {8'b0, packet[55:8]};
                bytes_left <= bytes_left - 1'b1;
                if (bytes_left == 1)
                    ack <= req_sync;
            end
            if (tx_valid && tx_ready) begin
                response <= {tx_data, response[111:8]};
                response_bytes <= response_bytes + 1'b1;
            end
            if (req_sync != ack && !rx_valid) begin
                case (request[63:56])
                    8'd1: begin
                        packet <= request[55:0];
                        bytes_left <= 7;
                    end
                    8'd2: begin
                        restart <= 1;
                        response_bytes <= 0;
                        ack <= req_sync;
                    end
                    8'd3: begin
                        if (result_ready)
                            response_bytes <= 0;
                        ack <= req_sync;
                    end
                    default: ack <= req_sync;
                endcase
            end
        end
    end
endmodule
